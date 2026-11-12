import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { env } from '../config/env.js';
import {
  hashPassword,
  comparePassword,
  generateAccessToken,
  generateRefreshToken,
  hashToken
} from '../utils/crypto.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { logAudit } from '../services/audit.service.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required')
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long')
});

const refreshSchema = z.object({
  refreshToken: z.string().optional()
});

// Progressive delay & rate-limiting maps
const ipRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const failureAttemptsMap = new Map<string, { attempts: number; resetAt: number }>();
const MAX_LOGIN_REQUESTS_PER_MINUTE = 60;
// Constant dummy bcrypt hash for timing equivalence when user is not found
const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuvwxyz123456789012345678901234567890';

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipRateLimitMap.set(ip, { count: 1, resetAt: now + 60 * 1000 });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_LOGIN_REQUESTS_PER_MINUTE;
}

/**
 * Helper to set secure httpOnly refresh cookie
 */
function setRefreshCookie(res: Response, token: string) {
  res.cookie('refreshToken', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    path: '/api/v1/auth'
  });
}

/**
 * POST /api/v1/auth/login
 */
router.post('/login', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);

  // Per-IP rate limiting
  if (!checkIpRateLimit(ipAddress)) {
    return res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts from this IP address. Please try again later.'
    });
  }

  const parseResult = loginSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { username, password } = parseResult.data;

  try {
    const userRes = await pool.query(
      `SELECT id, username, email, password_hash, full_name, role, is_active, must_change_password, failed_login_count, locked_until
       FROM users
       WHERE username = $1`,
      [username]
    );

    if (userRes.rows.length === 0) {
      // Timing equivalence: run bcrypt comparison against dummy hash
      await comparePassword(password, DUMMY_HASH);

      const failureKey = `${username.toLowerCase()}_${ipAddress}`;
      const now = Date.now();
      const entry = failureAttemptsMap.get(failureKey);
      const attempts = entry && now < entry.resetAt ? entry.attempts + 1 : 1;
      failureAttemptsMap.set(failureKey, { attempts, resetAt: now + 15 * 60 * 1000 });

      const delayMs = Math.min(Math.max(0, (attempts - 1) * 200), 2000);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    const user = userRes.rows[0];

    // Check account lockout or progressive delay window
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMs = Math.min(new Date(user.locked_until).getTime() - Date.now(), 2000);
      await comparePassword(password, DUMMY_HASH);
      if (remainingMs > 0) {
        await new Promise((r) => setTimeout(r, remainingMs));
      }
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    if (!user.is_active) {
      return res.status(403).json({
        error: 'ACCOUNT_DEACTIVATED',
        message: 'This account has been deactivated. Contact an administrator.'
      });
    }

    // Verify password
    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      const attempts = (user.failed_login_count || 0) + 1;
      const delayMs = Math.min(Math.max(0, (attempts - 1) * 200), 2000);
      const lockedUntil = delayMs > 0 ? new Date(Date.now() + delayMs) : null;

      await pool.query(
        `UPDATE users
         SET failed_login_count = $1, locked_until = $2, updated_at = NOW()
         WHERE id = $3`,
        [attempts, lockedUntil, user.id]
      );

      await logAudit({
        userId: user.id,
        action: 'LOGIN_FAILED',
        entity: 'USER',
        entityId: user.id,
        beforeState: { attemptsBefore: user.failed_login_count },
        afterState: { attemptsAfter: attempts, lockedUntil },
        ipAddress
      });

      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    // Reset failed attempts on success and record last_login_at
    await pool.query(
      `UPDATE users
       SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [user.id]
    );

    // Issue tokens
    const authUser = {
      id: user.id,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      isActive: user.is_active,
      mustChangePassword: user.must_change_password
    };

    const accessToken = generateAccessToken(authUser);
    const refreshToken = generateRefreshToken();
    const tokenHashed = hashToken(refreshToken);

    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const userAgent = (req.headers['user-agent'] as string) || null;

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, tokenHashed, expiresAt, ipAddress, userAgent]
    );

    setRefreshCookie(res, refreshToken);

    await logAudit({
      userId: user.id,
      action: 'LOGIN_SUCCESS',
      entity: 'USER',
      entityId: user.id,
      ipAddress
    });

    return res.json({
      accessToken,
      user: authUser
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An error occurred during authentication'
    });
  }
});

/**
 * POST /api/v1/auth/refresh
 * Implements Token Rotation and Automatic Reuse Detection
 */
router.post('/refresh', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const rawRefreshToken = req.cookies?.refreshToken;

  if (!rawRefreshToken) {
    return res.status(401).json({
      error: 'REFRESH_TOKEN_REQUIRED',
      message: 'Refresh token must be provided via httpOnly cookie'
    });
  }

  const tokenHashed = hashToken(rawRefreshToken);

  try {
    const tokenRes = await pool.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.family_id,
              u.id as user_id, u.username, u.full_name, u.role, u.is_active, u.must_change_password
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.token_hash = $1`,
      [tokenHashed]
    );

    if (tokenRes.rows.length === 0) {
      return res.status(401).json({
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token not recognized'
      });
    }

    const tokenRow = tokenRes.rows[0];

    // REUSE DETECTION: If an already-revoked token is presented, trigger compromise defense!
    if (tokenRow.revoked_at !== null) {
      // Invalidate ALL refresh tokens in the family / for this user
      await pool.query(
        `UPDATE refresh_tokens
         SET revoked_at = NOW()
         WHERE (family_id = $1 OR user_id = $2) AND revoked_at IS NULL`,
        [tokenRow.family_id, tokenRow.user_id]
      );

      await logAudit({
        userId: tokenRow.user_id,
        action: 'TOKEN_REUSE_DETECTED',
        entity: 'SECURITY',
        entityId: tokenRow.user_id,
        afterState: { familyId: tokenRow.family_id, revokedAllTokensForUser: true },
        ipAddress
      });

      res.clearCookie('refreshToken', { path: '/api/v1/auth' });
      return res.status(403).json({
        error: 'TOKEN_REUSE_COMPROMISED',
        message: 'Security violation: Refresh token reuse detected. All active sessions have been invalidated.'
      });
    }

    // Expiry check
    if (new Date(tokenRow.expires_at) < new Date()) {
      return res.status(401).json({
        error: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired. Please log in again.'
      });
    }

    if (!tokenRow.is_active) {
      return res.status(403).json({
        error: 'ACCOUNT_DEACTIVATED',
        message: 'User account is inactive'
      });
    }

    // Generate new token and link replaced_by
    const newRefreshToken = generateRefreshToken();
    const newTokenHashed = hashToken(newRefreshToken);

    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW(), replaced_by = $1
       WHERE id = $2`,
      [newTokenHashed, tokenRow.id]
    );

    // Issue new token pair preserving family_id
    const authUser = {
      id: tokenRow.user_id,
      username: tokenRow.username,
      fullName: tokenRow.full_name,
      role: tokenRow.role,
      isActive: tokenRow.is_active,
      mustChangePassword: tokenRow.must_change_password
    };

    const newAccessToken = generateAccessToken(authUser);
    const newExpiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const userAgent = (req.headers['user-agent'] as string) || null;

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tokenRow.user_id, newTokenHashed, newExpiresAt, tokenRow.family_id, ipAddress, userAgent]
    );

    setRefreshCookie(res, newRefreshToken);

    return res.json({
      accessToken: newAccessToken,
      user: authUser
    });
  } catch (error) {
    console.error('Refresh error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to refresh authentication token'
    });
  }
});

/**
 * POST /api/v1/auth/logout
 */
router.post('/logout', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const tokenFromCookie = req.cookies?.refreshToken;
  const tokenFromBody = req.body?.refreshToken;
  const rawRefreshToken = tokenFromCookie || tokenFromBody;

  if (rawRefreshToken) {
    const tokenHashed = hashToken(rawRefreshToken);
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHashed]
    );
  }

  res.clearCookie('refreshToken', { path: '/api/v1/auth' });

  if (req.user) {
    await logAudit({
      userId: req.user.id,
      action: 'USER_LOGOUT',
      entity: 'USER',
      entityId: req.user.id,
      ipAddress
    });
  }

  return res.json({ message: 'Logged out successfully' });
});

/**
 * POST /api/v1/auth/change-password
 * Handles mandatory password change on bootstrap / temporary password
 */
router.post('/change-password', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = changePasswordSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { oldPassword, newPassword } = parseResult.data;
  const userId = req.user!.id;

  try {
    const userRes = await pool.query(
      `SELECT password_hash, username, full_name, role, is_active FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRes.rows[0];

    const isMatch = await comparePassword(oldPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({
        error: 'INVALID_CURRENT_PASSWORD',
        message: 'The current password you provided is incorrect'
      });
    }

    const newHash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, updated_at = NOW()
       WHERE id = $2`,
      [newHash, userId]
    );

    // Invalidate all existing refresh tokens after password change
    await pool.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );

    // Issue fresh tokens with mustChangePassword = false
    const authUser = {
      id: userId,
      username: user.username,
      fullName: user.full_name,
      role: user.role,
      isActive: user.is_active,
      mustChangePassword: false
    };

    const newAccessToken = generateAccessToken(authUser);
    const newRefreshToken = generateRefreshToken();
    const newExpiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, hashToken(newRefreshToken), newExpiresAt]
    );

    setRefreshCookie(res, newRefreshToken);

    await logAudit({
      userId,
      action: 'USER_PASSWORD_CHANGE',
      entity: 'USER',
      entityId: userId,
      afterState: { mustChangePassword: false },
      ipAddress
    });

    return res.json({
      message: 'Password changed successfully',
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      user: authUser
    });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update password'
    });
  }
});

/**
 * GET /api/v1/auth/me
 */
router.get('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  return res.json({
    user: req.user
  });
});

export { router as authRouter };

