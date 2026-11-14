import { Router, Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
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

// Rate limiting on login route (10 attempts / 15 min per IP + lower(username))
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    if (process.env.NODE_ENV === 'test' && !req.headers['x-enforce-rate-limit']) {
      return 1000;
    }
    return 10;
  },
  keyGenerator: (req) => {
    const ip = getClientIp(req);
    const username = (req.body?.username || '').toString().toLowerCase().trim();
    return `${ip}_${username}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many login attempts. Please try again later.'
  }
});

interface ProgressiveDelayTracker {
  count: number;
  lastAttempt: number;
}
const progressiveDelayMap = new Map<string, ProgressiveDelayTracker>();

export function getProgressiveDelay(ip: string, username: string): number {
  const key = `${ip}_${username.toLowerCase().trim()}`;
  const now = Date.now();
  const entry = progressiveDelayMap.get(key);

  if (!entry || (now - entry.lastAttempt > 15 * 60 * 1000)) {
    progressiveDelayMap.set(key, { count: 1, lastAttempt: now });
    return 0;
  }

  entry.count += 1;
  entry.lastAttempt = now;
  // Delay increases by 200ms per subsequent failure, capped at 2000ms (2s)
  const delayMs = Math.min((entry.count - 1) * 200, 2000);
  return delayMs;
}

export function clearProgressiveDelay(ip: string, username: string): void {
  const key = `${ip}_${username.toLowerCase().trim()}`;
  progressiveDelayMap.delete(key);
}

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required')
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters long').max(72, 'Password must not exceed 72 characters')
});

// Constant dummy bcrypt hash for timing equivalence on non-existent users
const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuvwxyz123456789012345678901234567890';

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
router.post('/login', loginLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
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
       WHERE lower(username) = lower($1)`,
      [username]
    );

    // 1. Unknown user: timing equivalence & audit log
    if (userRes.rows.length === 0) {
      await comparePassword(password, DUMMY_HASH);
      const delay = getProgressiveDelay(ipAddress, username);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      await logAudit({
        userId: null,
        action: 'LOGIN_FAILED',
        entity: 'USER',
        entityId: username.toLowerCase(),
        afterState: { attemptedUsername: username, reason: 'UNKNOWN_USER' },
        ipAddress
      });

      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    const user = userRes.rows[0];

    // 2. Locked user: timing equivalence & identical 401
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await comparePassword(password, DUMMY_HASH);
      const delay = getProgressiveDelay(ipAddress, username);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    // 3. Deactivated user: timing equivalence & identical 401
    if (!user.is_active) {
      await comparePassword(password, DUMMY_HASH);
      const delay = getProgressiveDelay(ipAddress, username);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    // 4. Verify password
    const isPasswordValid = await comparePassword(password, user.password_hash);
    if (!isPasswordValid) {
      // Atomic UPDATE for failed_login_count and locked_until
      const updateRes = await pool.query(
        `UPDATE users
         SET failed_login_count = failed_login_count + 1,
             locked_until = CASE 
               WHEN failed_login_count + 1 >= 5 THEN NOW() + INTERVAL '15 minutes'
               ELSE NULL 
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING failed_login_count, locked_until`,
        [user.id]
      );

      const updated = updateRes.rows[0];

      await logAudit({
        userId: user.id,
        action: 'LOGIN_FAILED',
        entity: 'USER',
        entityId: user.id,
        beforeState: { attemptsBefore: user.failed_login_count },
        afterState: { attemptsAfter: updated.failed_login_count, lockedUntil: updated.locked_until },
        ipAddress
      });

      const delay = getProgressiveDelay(ipAddress, username);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      return res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password'
      });
    }

    // Reset failed attempts on success, clear progressive delay, and record last_login_at
    clearProgressiveDelay(ipAddress, username);
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
 * Implements atomic token rotation, 15-second concurrent tab grace window,
 * and malicious reuse detection.
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
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Try atomic rotation of an unrevoked token
    const newRefreshToken = generateRefreshToken();
    const newTokenHashed = hashToken(newRefreshToken);
    const newExpiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const userAgent = (req.headers['user-agent'] as string) || null;

    const rotateRes = await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW(), replaced_by = $1
       WHERE token_hash = $2 AND revoked_at IS NULL
       RETURNING id, user_id, expires_at, family_id`,
      [newTokenHashed, tokenHashed]
    );

    if (rotateRes.rows.length > 0) {
      const rotated = rotateRes.rows[0];

      // Expiry check
      if (new Date(rotated.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(401).json({
          error: 'REFRESH_TOKEN_EXPIRED',
          message: 'Refresh token has expired'
        });
      }

      // Check user status
      const userRes = await client.query(
        `SELECT id, username, full_name, role, is_active, must_change_password
         FROM users WHERE id = $1`,
        [rotated.user_id]
      );

      if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'ACCOUNT_DEACTIVATED',
          message: 'User account is inactive'
        });
      }

      const user = userRes.rows[0];

      // Insert new token preserving family_id
      await client.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, family_id, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [user.id, newTokenHashed, newExpiresAt, rotated.family_id, ipAddress, userAgent]
      );

      await client.query('COMMIT');

      setRefreshCookie(res, newRefreshToken);

      const authUser = {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
        isActive: user.is_active,
        mustChangePassword: user.must_change_password
      };

      return res.json({
        accessToken: generateAccessToken(authUser),
        user: authUser
      });
    }

    // 2. Token is already revoked or does not exist
    const tokenRes = await client.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.family_id, rt.replaced_by,
              u.id as user_id, u.username, u.full_name, u.role, u.is_active, u.must_change_password
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.token_hash = $1`,
      [tokenHashed]
    );

    if (tokenRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(401).json({
        error: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token not recognized'
      });
    }

    const tokenRow = tokenRes.rows[0];
    const revokedAt = new Date(tokenRow.revoked_at);
    const secondsSinceRevocation = (Date.now() - revokedAt.getTime()) / 1000;

    // Grace Window: ONLY for a token that was legitimately rotated (replaced_by IS NOT NULL) within the last 15 seconds
    if (Boolean(tokenRow.replaced_by) && secondsSinceRevocation <= 15) {
      await client.query('COMMIT');

      const authUser = {
        id: tokenRow.user_id,
        username: tokenRow.username,
        fullName: tokenRow.full_name,
        role: tokenRow.role,
        isActive: tokenRow.is_active,
        mustChangePassword: tokenRow.must_change_password
      };

      // Return a fresh access token without invalidating sessions or forking family
      return res.json({
        accessToken: generateAccessToken(authUser),
        user: authUser
      });
    }

    // 3. Real reuse attack (> 15 seconds since revocation): Trigger compromise defense!
    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = NOW()
       WHERE family_id = $1 AND revoked_at IS NULL`,
      [tokenRow.family_id]
    );

    await logAudit({
      userId: tokenRow.user_id,
      action: 'TOKEN_REUSE_DETECTED',
      entity: 'SECURITY',
      entityId: tokenRow.user_id,
      afterState: { familyId: tokenRow.family_id, revokedAllTokensForUser: true },
      ipAddress,
      client
    });

    await client.query('COMMIT');

    res.clearCookie('refreshToken', { path: '/api/v1/auth' });
    return res.status(403).json({
      error: 'TOKEN_REUSE_COMPROMISED',
      message: 'Security violation: Refresh token reuse detected. All active sessions have been invalidated.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Refresh error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to refresh authentication token'
    });
  } finally {
    client.release();
  }
});

/**
 * POST /api/v1/auth/logout
 */
router.post('/logout', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const rawRefreshToken = req.cookies?.refreshToken;

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
 * Password policy: 8-72 characters, new != old
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

  // New password must not be identical to old password
  if (oldPassword === newPassword) {
    return res.status(400).json({
      error: 'PASSWORD_UNCHANGED',
      message: 'New password cannot be the same as your current password'
    });
  }

  try {
    const userRes = await pool.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const isMatch = await comparePassword(oldPassword, userRes.rows[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({
        error: 'INVALID_CURRENT_PASSWORD',
        message: 'Current password provided is incorrect'
      });
    }

    // Verify new password doesn't match current hash
    const isSameAsCurrent = await comparePassword(newPassword, userRes.rows[0].password_hash);
    if (isSameAsCurrent) {
      return res.status(400).json({
        error: 'PASSWORD_UNCHANGED',
        message: 'New password cannot be the same as your current password'
      });
    }

    const newHash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = false, updated_at = NOW()
       WHERE id = $2`,
      [newHash, userId]
    );

    await logAudit({
      userId,
      action: 'PASSWORD_CHANGED',
      entity: 'USER',
      entityId: userId,
      ipAddress
    });

    // Fetch updated user to issue fresh access token
    const updatedUserRes = await pool.query(
      'SELECT id, username, full_name, role, is_active, must_change_password FROM users WHERE id = $1',
      [userId]
    );
    const updatedUser = updatedUserRes.rows[0];

    const authUser = {
      id: updatedUser.id,
      username: updatedUser.username,
      fullName: updatedUser.full_name,
      role: updatedUser.role,
      isActive: updatedUser.is_active,
      mustChangePassword: updatedUser.must_change_password
    };

    const newAccessToken = generateAccessToken(authUser);

    return res.json({
      message: 'Password changed successfully',
      accessToken: newAccessToken,
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
  return res.json({ user: req.user });
});

export { router as authRouter };
