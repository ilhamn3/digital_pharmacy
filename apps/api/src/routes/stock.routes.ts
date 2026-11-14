import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { logAuditWithClient } from '../services/audit.service.js';

const router = Router();

// Stock management and inventory inspection is strictly restricted to Owner and Pharmacist
// Cashier gets 403 Forbidden on all routes in this module
router.use(authenticate, requireRoles('owner', 'pharmacist'));

const stockAdjustmentSchema = z.object({
  batchId: z.string().uuid('Valid batch ID is required'),
  adjustmentType: z.enum(['damage', 'expired_write_off', 'correction']),
  quantityChange: z.number().refine((val) => val !== 0, {
    message: 'Quantity change must not be zero'
  }),
  reason: z.string().min(3, 'Adjustment reason is mandatory and must be at least 3 characters long').trim()
});

/**
 * POST /api/v1/stock/adjustments
 * Execute a stock adjustment in ONE atomic DB transaction:
 * - Writes stock_movements (type 'adjustment')
 * - Links stock_adjustments.movement_id
 * - Disallows taking batch stock below zero
 * - Enforces owner approval if cost value exceeds settings threshold
 * - Writes audit log
 */
router.post('/adjustments', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = stockAdjustmentSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { batchId, adjustmentType, quantityChange, reason } = parseResult.data;
  const userId = req.user!.id;
  const userRole = req.user!.role;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock the target batch
    const batchRes = await client.query(
      `SELECT b.*, p.name as product_name
       FROM batches b
       JOIN products p ON b.product_id = p.id
       WHERE b.id = $1
       FOR UPDATE`,
      [batchId]
    );

    if (batchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Batch not found' });
    }

    const batch = batchRes.rows[0];
    const currentQty = Number(batch.current_quantity);
    const newQty = Math.round((currentQty + quantityChange) * 100) / 100;

    // 2. Prevent negative stock
    if (newQty < 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'NEGATIVE_STOCK_DISALLOWED',
        message: `Adjustment would result in negative stock. Current: ${currentQty}, change: ${quantityChange}, resulting: ${newQty}`
      });
    }

    // 3. Expiry verification for expired_write_off: batch must actually be expired
    const todayStr = new Date().toISOString().split('T')[0];
    const expiryDateStr = new Date(batch.expiry_date).toISOString().split('T')[0];
    const isExpired = expiryDateStr < todayStr;
    if (adjustmentType === 'expired_write_off' && !isExpired) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'BATCH_NOT_EXPIRED',
        message: `Cannot perform expired write-off: batch '${batch.batch_no}' has not expired yet (expiry date: ${expiryDateStr}).`
      });
    }

    // 4. Check owner approval thresholds & cumulative limits from settings
    const costPrice = Number(batch.cost_price);
    const adjustmentValue = Math.round(Math.abs(quantityChange) * costPrice * 100) / 100;

    const settingsRes = await client.query(
      `SELECT value FROM settings WHERE key = 'inventory_settings'`
    );
    const invSettings = settingsRes.rows[0]?.value || {};
    const maxThreshold = typeof invSettings.max_unapproved_adjustment_cost === 'number'
      ? invSettings.max_unapproved_adjustment_cost
      : 5000.00;

    if (adjustmentValue > maxThreshold && userRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'OWNER_APPROVAL_REQUIRED',
        message: `Adjustment value of Rs. ${adjustmentValue.toFixed(2)} exceeds the threshold of Rs. ${maxThreshold.toFixed(2)}. Owner approval is required.`
      });
    }

    // Positive stock correction above threshold requires owner role
    const positiveCorrectionOwnerThreshold = typeof invSettings.positive_correction_owner_threshold === 'number'
      ? invSettings.positive_correction_owner_threshold
      : 1000.00;

    if (adjustmentType === 'correction' && quantityChange > 0 && adjustmentValue > positiveCorrectionOwnerThreshold && userRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'OWNER_APPROVAL_REQUIRED',
        message: `Positive stock correction value of Rs. ${adjustmentValue.toFixed(2)} exceeds threshold of Rs. ${positiveCorrectionOwnerThreshold.toFixed(2)}. Owner role required.`
      });
    }

    // Cumulative daily limit check per user
    const maxDailyLimit = typeof invSettings.max_daily_adjustment_cost_per_user === 'number'
      ? invSettings.max_daily_adjustment_cost_per_user
      : 10000.00;

    const dailyRes = await client.query(
      `SELECT COALESCE(SUM(ROUND(ABS(sa.quantity_change) * b.cost_price, 2)), 0.00)::NUMERIC(12,2) AS daily_total
       FROM stock_adjustments sa
       JOIN batches b ON sa.batch_id = b.id
       WHERE sa.adjusted_by = $1 AND sa.created_at >= CURRENT_DATE`,
      [userId]
    );
    const userDailyTotal = Number(dailyRes.rows[0]?.daily_total || 0);

    if (userDailyTotal + adjustmentValue > maxDailyLimit && userRole !== 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'DAILY_LIMIT_EXCEEDED',
        message: `Cumulative daily stock adjustment limit of Rs. ${maxDailyLimit.toFixed(2)} exceeded (today: Rs. ${userDailyTotal.toFixed(2)}, requested: Rs. ${adjustmentValue.toFixed(2)}). Owner override required.`
      });
    }

    // 5. Insert into stock_movements (triggers apply_stock_movement_to_batch which updates batches.current_quantity)
    const movRes = await client.query(
      `INSERT INTO stock_movements (
         batch_id, movement_type, qty_change, ref_type, ref_id, created_by
       ) VALUES ($1, 'adjustment', $2, 'stock_adjustment', gen_random_uuid(), $3)
       RETURNING id, created_at`,
      [batchId, quantityChange, userId]
    );
    const movement = movRes.rows[0];

    // 5. Insert into stock_adjustments, linking movement_id
    const adjRes = await client.query(
      `INSERT INTO stock_adjustments (
         batch_id, adjustment_type, quantity_change, reason, adjusted_by, movement_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, adjustment_type, quantity_change, reason, created_at`,
      [batchId, adjustmentType, quantityChange, reason, userId, movement.id]
    );
    const adjustment = adjRes.rows[0];

    // 6. Write audit log in same transaction
    await logAuditWithClient(client, {
      userId,
      action: 'STOCK_ADJUSTMENT',
      entity: 'BATCH',
      entityId: batchId,
      beforeState: {
        batchNo: batch.batch_no,
        productName: batch.product_name,
        currentQuantity: currentQty
      },
      afterState: {
        adjustmentId: adjustment.id,
        movementId: movement.id,
        adjustmentType,
        quantityChange,
        adjustmentCostValue: adjustmentValue,
        newQuantity: newQty,
        reason
      },
      ipAddress
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Stock adjustment applied successfully',
      adjustment: {
        id: adjustment.id,
        batchId,
        batchNo: batch.batch_no,
        productName: batch.product_name,
        adjustmentType: adjustment.adjustment_type,
        quantityChange: adjustment.quantity_change,
        previousQuantity: currentQty,
        newQuantity: newQty,
        costValue: adjustmentValue,
        reason: adjustment.reason,
        movementId: movement.id,
        createdAt: adjustment.created_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Stock adjustment error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to record stock adjustment' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/stock/adjustments
 * List stock adjustments with filters
 */
router.get('/adjustments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 100);
    const offset = parseInt(String(req.query.offset || '0'), 10);
    const batchId = req.query.batchId ? String(req.query.batchId) : null;
    const adjustmentType = req.query.adjustmentType ? String(req.query.adjustmentType) : null;

    const whereClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (batchId) {
      whereClauses.push(`sa.batch_id = $${idx++}`);
      values.push(batchId);
    }
    if (adjustmentType) {
      whereClauses.push(`sa.adjustment_type = $${idx++}`);
      values.push(adjustmentType);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await pool.query(`SELECT COUNT(*)::INT as total FROM stock_adjustments sa ${whereSql}`, values);
    const total = countRes.rows[0].total;

    const query = `
      SELECT 
        sa.id,
        sa.batch_id,
        b.batch_no,
        b.cost_price,
        p.id as product_id,
        p.name as product_name,
        sa.adjustment_type,
        sa.quantity_change,
        ROUND(ABS(sa.quantity_change) * b.cost_price, 2) as cost_value,
        sa.reason,
        sa.movement_id,
        u.full_name as adjusted_by_name,
        sa.created_at
      FROM stock_adjustments sa
      JOIN batches b ON sa.batch_id = b.id
      JOIN products p ON b.product_id = p.id
      JOIN users u ON sa.adjusted_by = u.id
      ${whereSql}
      ORDER BY sa.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    values.push(limit, offset);

    const listRes = await pool.query(query, values);

    return res.json({
      total,
      limit,
      offset,
      adjustments: listRes.rows.map((row) => ({
        id: row.id,
        batchId: row.batch_id,
        batchNo: row.batch_no,
        productId: row.product_id,
        productName: row.product_name,
        adjustmentType: row.adjustment_type,
        quantityChange: row.quantity_change,
        costPrice: row.cost_price,
        costValue: row.cost_value,
        reason: row.reason,
        movementId: row.movement_id,
        adjustedBy: row.adjusted_by_name,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('List adjustments error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list stock adjustments' });
  }
});

/**
 * GET /api/v1/stock/low-stock
 * List products where non-expired active stock <= reorder_level, with value-at-cost
 */
router.get('/low-stock', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const query = `
      SELECT 
        p.id,
        p.name,
        p.generic_name,
        p.barcode,
        p.category,
        p.unit,
        p.pack_size,
        p.reorder_level,
        COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date >= CURRENT_DATE AND b.is_active = true), 0)::NUMERIC(12,2) AS current_stock,
        COALESCE(ROUND(SUM(b.current_quantity * b.cost_price) FILTER (WHERE b.expiry_date >= CURRENT_DATE AND b.is_active = true), 2), 0.00)::NUMERIC(12,2) AS value_at_cost,
        COUNT(b.id) FILTER (WHERE b.current_quantity > 0 AND b.expiry_date >= CURRENT_DATE AND b.is_active = true)::INT AS active_batch_count
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id
      WHERE p.is_active = true
      GROUP BY p.id
      HAVING COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date >= CURRENT_DATE AND b.is_active = true), 0) <= p.reorder_level
      ORDER BY (COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date >= CURRENT_DATE AND b.is_active = true), 0) - p.reorder_level) ASC, p.name ASC
    `;

    const result = await pool.query(query);

    return res.json({
      count: result.rows.length,
      products: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        genericName: row.generic_name,
        barcode: row.barcode,
        category: row.category,
        unit: row.unit,
        packSize: row.pack_size,
        reorderLevel: row.reorder_level,
        currentStock: row.current_stock,
        valueAtCost: row.value_at_cost,
        activeBatchCount: row.active_batch_count
      }))
    });
  } catch (error) {
    console.error('Low stock error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve low stock list' });
  }
});

/**
 * GET /api/v1/stock/expiring
 * List batches expiring in 30, 60, or 90 days with remaining quantity and value-at-cost
 */
router.get('/expiring', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const days = parseInt(String(req.query.days || '90'), 10);
    const validDays = [30, 60, 90].includes(days) ? days : 90;

    const query = `
      SELECT 
        b.id as batch_id,
        b.batch_no,
        b.expiry_date,
        (b.expiry_date - CURRENT_DATE)::INT as days_until_expiry,
        b.current_quantity,
        b.cost_price,
        b.mrp,
        ROUND(b.current_quantity * b.cost_price, 2) as value_at_cost,
        p.id as product_id,
        p.name as product_name,
        p.generic_name,
        p.unit,
        s.name as supplier_name
      FROM batches b
      JOIN products p ON b.product_id = p.id
      LEFT JOIN suppliers s ON b.supplier_id = s.id
      WHERE b.is_active = true
        AND b.current_quantity > 0
        AND b.expiry_date >= CURRENT_DATE
        AND b.expiry_date <= CURRENT_DATE + ($1 * INTERVAL '1 day')
      ORDER BY b.expiry_date ASC, b.current_quantity DESC
    `;

    const result = await pool.query(query, [validDays]);

    const totalExpiringStock = result.rows.reduce((sum, r) => sum + Number(r.current_quantity), 0);
    const totalExpiringValue = result.rows.reduce((sum, r) => sum + Number(r.value_at_cost), 0);

    return res.json({
      daysWindow: validDays,
      batchCount: result.rows.length,
      totalExpiringStock: Math.round(totalExpiringStock * 100) / 100,
      totalExpiringValueAtCost: Math.round(totalExpiringValue * 100) / 100,
      batches: result.rows.map((r) => ({
        batchId: r.batch_id,
        batchNo: r.batch_no,
        expiryDate: r.expiry_date,
        daysUntilExpiry: r.days_until_expiry,
        currentQuantity: r.current_quantity,
        costPrice: r.cost_price,
        mrp: r.mrp,
        valueAtCost: r.value_at_cost,
        productId: r.product_id,
        productName: r.product_name,
        genericName: r.generic_name,
        unit: r.unit,
        supplierName: r.supplier_name
      }))
    });
  } catch (error) {
    console.error('Expiring stock error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve expiring stock list' });
  }
});

/**
 * GET /api/v1/stock/expired
 * List already expired batches that still have positive stock (candidates for write-off), with value-at-cost
 */
router.get('/expired', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const query = `
      SELECT 
        b.id as batch_id,
        b.batch_no,
        b.expiry_date,
        (CURRENT_DATE - b.expiry_date)::INT as days_expired,
        b.current_quantity,
        b.cost_price,
        b.mrp,
        ROUND(b.current_quantity * b.cost_price, 2) as value_at_cost,
        p.id as product_id,
        p.name as product_name,
        p.generic_name,
        p.unit,
        s.name as supplier_name
      FROM batches b
      JOIN products p ON b.product_id = p.id
      LEFT JOIN suppliers s ON b.supplier_id = s.id
      WHERE b.is_active = true
        AND b.current_quantity > 0
        AND b.expiry_date < CURRENT_DATE
      ORDER BY b.expiry_date ASC, b.current_quantity DESC
    `;

    const result = await pool.query(query);

    const totalExpiredStock = result.rows.reduce((sum, r) => sum + Number(r.current_quantity), 0);
    const totalExpiredValue = result.rows.reduce((sum, r) => sum + Number(r.value_at_cost), 0);

    return res.json({
      batchCount: result.rows.length,
      totalExpiredStock: Math.round(totalExpiredStock * 100) / 100,
      totalExpiredValueAtCost: Math.round(totalExpiredValue * 100) / 100,
      batches: result.rows.map((r) => ({
        batchId: r.batch_id,
        batchNo: r.batch_no,
        expiryDate: r.expiry_date,
        daysExpired: r.days_expired,
        currentQuantity: r.current_quantity,
        costPrice: r.cost_price,
        mrp: r.mrp,
        valueAtCost: r.value_at_cost,
        productId: r.product_id,
        productName: r.product_name,
        genericName: r.generic_name,
        unit: r.unit,
        supplierName: r.supplier_name
      }))
    });
  } catch (error) {
    console.error('Expired stock error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve expired stock list' });
  }
});

import { reconcileBatchStock } from '../services/fefo.service.js';

/**
 * GET /api/v1/stock/reconcile/:batchId
 * Reconcile batches.current_quantity with SUM(stock_movements.qty_change) strictly in SQL
 */
router.get('/reconcile/:batchId', async (req: AuthenticatedRequest, res: Response) => {
  const batchId = String(req.params.batchId);

  try {
    const recon = await reconcileBatchStock(pool, batchId);

    const movCountRes = await pool.query(
      `SELECT COUNT(id)::int as movement_count FROM stock_movements WHERE batch_id = $1`,
      [batchId]
    );

    return res.json({
      batchId: recon.batchId,
      batchNo: recon.batchNo,
      currentQuantity: recon.currentQuantity,
      movementsSum: recon.movementSum,
      movementCount: movCountRes.rows[0]?.movement_count || 0,
      isReconciled: recon.reconciled,
      discrepancy: recon.reconciled ? 0 : 'mismatch'
    });
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: error.message });
    }
    console.error('Reconcile batch error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to reconcile batch' });
  }
});

export { router as stockRouter };

