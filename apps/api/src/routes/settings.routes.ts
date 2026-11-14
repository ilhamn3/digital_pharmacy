import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { logAudit } from '../services/audit.service.js';

const router = Router();

// Read settings allowed for authenticated staff (Owner, Pharmacist)
// Mutations are strictly restricted to Owner only
router.use(authenticate);

/**
 * GET /api/v1/settings
 * List all system settings
 */
router.get('/', requireRoles('owner', 'pharmacist'), async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query('SELECT key, value, description, updated_at FROM settings ORDER BY key ASC');
    return res.json({
      settings: result.rows
    });
  } catch (error) {
    console.error('List settings error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve settings' });
  }
});

/**
 * GET /api/v1/settings/:key
 * Retrieve single setting by key
 */
router.get('/:key', requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const key = String(req.params.key);
  try {
    const result = await pool.query('SELECT key, value, description, updated_at FROM settings WHERE key = $1', [key]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Setting '${key}' not found` });
    }
    return res.json({
      setting: result.rows[0]
    });
  } catch (error) {
    console.error('Get setting error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve setting' });
  }
});

/**
 * PUT /api/v1/settings/:key
 * Update setting value (Owner ONLY, audited)
 */
const updateSettingSchema = z.object({
  value: z.record(z.any()).or(z.array(z.any())).or(z.string()).or(z.number()).or(z.boolean()),
  description: z.string().optional()
});

router.put('/:key', requireRoles('owner'), async (req: AuthenticatedRequest, res: Response) => {
  const key = String(req.params.key);
  const ipAddress = getClientIp(req);
  const parseResult = updateSettingSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { value, description } = parseResult.data;
  const userId = req.user!.id;

  try {
    const existing = await pool.query('SELECT key, value, description FROM settings WHERE key = $1', [key]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: `Setting '${key}' not found` });
    }

    const beforeState = existing.rows[0];

    const updateRes = await pool.query(
      `UPDATE settings
       SET value = $1,
           description = COALESCE($2, description),
           updated_at = NOW()
       WHERE key = $3
       RETURNING key, value, description, updated_at`,
      [JSON.stringify(value), description || null, key]
    );

    const updatedSetting = updateRes.rows[0];

    await logAudit({
      userId,
      action: 'SETTING_UPDATED',
      entity: 'SETTING',
      entityId: key,
      beforeState,
      afterState: updatedSetting,
      ipAddress
    });

    return res.json({
      message: `Setting '${key}' updated successfully`,
      setting: updatedSetting
    });
  } catch (error) {
    console.error('Update setting error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update setting' });
  }
});

export { router as settingsRouter };

