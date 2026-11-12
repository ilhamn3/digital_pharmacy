import { Response, NextFunction } from 'express';
import { pool } from '../db/pool.js';
import { verifyAccessToken } from '../utils/crypto.js';
import { AuthenticatedRequest } from '../types/auth.js';

export function getClientIp(req: AuthenticatedRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Validates JWT access token, enforces active account status,
 * lockout checks, and must_change_password constraints.
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
      `SELECT id, username, full_name, role, is_active, must_change_password, locked_until
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

    // Check account lockout
    if (dbUser.locked_until && new Date(dbUser.locked_until) > new Date()) {
      return res.status(403).json({
        error: 'ACCOUNT_LOCKED',
        message: `Account temporarily locked due to failed login attempts until ${new Date(dbUser.locked_until).toISOString()}`
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
    if (req.user.mustChangePassword) {
      const allowedPaths = [
        '/api/v1/auth/change-password',
        '/api/v1/auth/me',
        '/api/v1/auth/logout'
      ];

      const currentPath = req.baseUrl + req.path;
      const isAllowed = allowedPaths.some((p) => currentPath.endsWith(p) || req.path === '/change-password' || req.path === '/me' || req.path === '/logout');

      if (!isAllowed) {
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

