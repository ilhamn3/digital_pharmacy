import { Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { verifyAccessToken } from '../utils/crypto.js';
import { AuthenticatedRequest } from '../types/auth.js';

export function getClientIp(req: AuthenticatedRequest): string {
  return req.ip || '127.0.0.1';
}

/**
 * Validates JWT access token, enforces active account status,
 * and must_change_password constraints.
 */
export async function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authorization header missing or invalid format. Expected Bearer <token>'
    });
  }

  const token = authHeader.split(' ')[1];
  req.rawToken = token;

  try {
    const payload = verifyAccessToken(token);

    // Verify user status in DB
    const userRes = await pool.query(
      `SELECT id, username, full_name, role, is_active, must_change_password
       FROM users
       WHERE id = $1`,
      [payload.sub]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'User account no longer exists'
      });
    }

    const dbUser = userRes.rows[0];

    if (!dbUser.is_active) {
      return res.status(403).json({
        error: 'ACCOUNT_DEACTIVATED',
        message: 'Your account has been deactivated. Contact an administrator.'
      });
    }

    req.user = {
      id: dbUser.id,
      username: dbUser.username,
      fullName: dbUser.full_name,
      role: dbUser.role,
      isActive: dbUser.is_active,
      mustChangePassword: dbUser.must_change_password
    };

    // If user is required to change password, allow only change-password, me, and logout endpoints
    // Using exact match on req.originalUrl without query string
    if (req.user.mustChangePassword) {
      const urlPath = req.originalUrl.split('?')[0];
      const allowedPaths = new Set([
        '/api/v1/auth/change-password',
        '/api/v1/auth/me',
        '/api/v1/auth/logout'
      ]);

      if (!allowedPaths.has(urlPath)) {
        return res.status(403).json({
          error: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You must change your temporary password before accessing other system resources.'
        });
      }
    }

    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'TOKEN_EXPIRED',
        message: 'Access token has expired'
      });
    }
    return res.status(401).json({
      error: 'INVALID_TOKEN',
      message: 'Access token is invalid'
    });
  }
}

