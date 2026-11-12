import { Router, Response } from 'express';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

// Only owner can view system audit logs
router.use(authenticate, requireRoles('owner'));

/**
 * GET /api/v1/audit-logs
 * Filter audit logs with pagination
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const { action, entity, entityId, userId, startDate, endDate } = req.query;

  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = parseInt(req.query.offset as string, 10) || 0;

  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (action && typeof action === 'string') {
    conditions.push(`al.action = $${idx++}`);
    values.push(action);
  }
  if (entity && typeof entity === 'string') {
    conditions.push(`al.entity = $${idx++}`);
    values.push(entity);
  }
  if (entityId && typeof entityId === 'string') {
    conditions.push(`al.entity_id = $${idx++}`);
    values.push(entityId);
  }
  if (userId && typeof userId === 'string') {
    conditions.push(`al.user_id = $${idx++}`);
    values.push(userId);
  }
  if (startDate && typeof startDate === 'string') {
    conditions.push(`al.created_at >= $${idx++}`);
    values.push(new Date(startDate));
  }
  if (endDate && typeof endDate === 'string') {
    conditions.push(`al.created_at <= $${idx++}`);
    values.push(new Date(endDate));
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM audit_logs al ${whereClause}`,
      values
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT 
        al.id,
        al.user_id,
        u.username,
        u.full_name as user_full_name,
        al.action,
        al.entity,
        al.entity_id,
        al.before_state,
        al.after_state,
        al.ip_address,
        al.created_at
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    values.push(limit, offset);
    const logsRes = await pool.query(query, values);

    return res.json({
      total,
      limit,
      offset,
      logs: logsRes.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        username: row.username,
        userFullName: row.user_full_name,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        beforeState: row.before_state,
        afterState: row.after_state,
        ipAddress: row.ip_address,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('Fetch audit logs error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch audit logs' });
  }
});

export { router as auditRouter };

