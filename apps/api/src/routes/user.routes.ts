import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword } from '../utils/crypto.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

// All user management routes require 'owner' role
router.use(authenticate, requireRoles('owner'));

const createUserSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters long'),
  email: z.string().email('Invalid email address').optional(),
  password: z.string().min(8, 'Password must be at least 8 characters long'),
  fullName: z.string().min(1, 'Full name is required'),
  role: z.enum(['owner', 'pharmacist', 'cashier'])
});

const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  role: z.enum(['owner', 'pharmacist', 'cashier']).optional(),
  isActive: z.boolean().optional()
});

const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'New password must be at least 8 characters long')
});

/**
 * GET /api/v1/users
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const usersRes = await pool.query(`
      SELECT id, username, email, full_name, role, is_active, must_change_password, created_at, updated_at
      FROM users
      ORDER BY created_at DESC
    `);

    return res.json({
      users: usersRes.rows.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        fullName: u.full_name,
        role: u.role,
        isActive: u.is_active,
        mustChangePassword: u.must_change_password,
        createdAt: u.created_at,
        updatedAt: u.updated_at
      }))
    });
  } catch (error) {
    console.error('Fetch users error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch users' });
  }
});

/**
 * POST /api/v1/users
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = createUserSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { username, email, password, fullName, role } = parseResult.data;

  try {
    // Check username existence
    const existCheck = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existCheck.rows.length > 0) {
      return res.status(409).json({
        error: 'USERNAME_EXISTS',
        message: `Username '${username}' is already in use`
      });
    }

    const passwordHash = await hashPassword(password);

    const insertRes = await pool.query(`
      INSERT INTO users (username, email, password_hash, full_name, role, is_active, must_change_password)
      VALUES ($1, $2, $3, $4, $5, true, false)
      RETURNING id, username, email, full_name, role, is_active, created_at
    `, [username, email || null, passwordHash, fullName, role]);

    const newUser = insertRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'USER_CREATE',
      entity: 'USER',
      entityId: newUser.id,
      afterState: {
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        isActive: newUser.is_active
      },
      ipAddress
    });

    return res.status(201).json({
      message: 'User created successfully',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        isActive: newUser.is_active,
        createdAt: newUser.created_at
      }
    });
  } catch (error) {
    console.error('Create user error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create user' });
  }
});

/**
 * PUT /api/v1/users/:id
 */
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const userId = String(req.params.id);
  const parseResult = updateUserSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { fullName, role, isActive } = parseResult.data;

  try {
    const existingRes = await pool.query(
      'SELECT id, username, email, full_name, role, is_active FROM users WHERE id = $1',
      [userId]
    );

    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    const beforeUser = existingRes.rows[0];

    // Build update query dynamically
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (fullName !== undefined) {
      updates.push(`full_name = $${idx++}`);
      values.push(fullName);
    }
    if (role !== undefined) {
      updates.push(`role = $${idx++}`);
      values.push(role);
    }
    if (isActive !== undefined) {
      updates.push(`is_active = $${idx++}`);
      values.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'NO_CHANGES', message: 'No fields provided to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(userId);

    const updateQuery = `
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING id, username, email, full_name, role, is_active, updated_at
    `;

    const updateRes = await pool.query(updateQuery, values);
    const updatedUser = updateRes.rows[0];

    // If role changed or user was deactivated, revoke all their active refresh tokens
    if (role !== undefined || isActive === false) {
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId]
      );
    }

    await logAudit({
      userId: req.user!.id,
      action: 'USER_UPDATE',
      entity: 'USER',
      entityId: userId,
      beforeState: {
        fullName: beforeUser.full_name,
        role: beforeUser.role,
        isActive: beforeUser.is_active
      },
      afterState: {
        fullName: updatedUser.full_name,
        role: updatedUser.role,
        isActive: updatedUser.is_active
      },
      ipAddress
    });

    return res.json({
      message: 'User updated successfully',
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        fullName: updatedUser.full_name,
        role: updatedUser.role,
        isActive: updatedUser.is_active,
        updatedAt: updatedUser.updated_at
      }
    });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update user' });
  }
});

/**
 * POST /api/v1/users/:id/reset-password
 */
router.post('/:id/reset-password', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const userId = String(req.params.id);
  const parseResult = resetPasswordSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { newPassword } = parseResult.data;

  try {
    const userRes = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    const passwordHash = await hashPassword(newPassword);

    await pool.query(
      `UPDATE users
       SET password_hash = $1, must_change_password = true, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, userId]
    );

    // Invalidate all active sessions for this user
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId]
    );

    await logAudit({
      userId: req.user!.id,
      action: 'USER_PASSWORD_RESET',
      entity: 'USER',
      entityId: userId,
      afterState: { mustChangePassword: true },
      ipAddress
    });

    return res.json({
      message: 'Password reset successfully. The user must change their password on next login.'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to reset password' });
  }
});

export { router as userRouter };
