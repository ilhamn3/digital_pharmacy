import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { logAudit, logAuditWithClient } from '../services/audit.service.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

// Suppliers management is restricted to Owner and Pharmacist (Cashier has NO access)
router.use(authenticate, requireRoles('owner', 'pharmacist'));

const createSupplierSchema = z.object({
  name: z.string().min(1, 'Supplier name is required'),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  outstandingBalance: z.number().min(0, 'Outstanding balance cannot be negative').default(0)
});

const updateSupplierSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  isActive: z.boolean().optional()
});

/**
 * GET /api/v1/suppliers
 * List suppliers with search and active status filter
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  const { search, isActive } = req.query;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = parseInt(req.query.offset as string, 10) || 0;

  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (search && typeof search === 'string') {
    conditions.push(`(name ILIKE $${idx} OR phone ILIKE $${idx})`);
    values.push(`%${search.trim()}%`);
    idx++;
  }

  if (isActive !== undefined) {
    conditions.push(`is_active = $${idx++}`);
    values.push(isActive === 'true');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM suppliers ${whereClause}`,
      values.slice(0, idx - 1)
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT 
        id,
        name,
        phone,
        address,
        outstanding_balance,
        is_active,
        created_at,
        updated_at
      FROM suppliers
      ${whereClause}
      ORDER BY name ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    values.push(limit, offset);
    const result = await pool.query(query, values);

    return res.json({
      total,
      limit,
      offset,
      suppliers: result.rows.map((s) => ({
        id: s.id,
        name: s.name,
        phone: s.phone,
        address: s.address,
        outstandingBalance: s.outstanding_balance,
        isActive: s.is_active,
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }))
    });
  } catch (error) {
    console.error('List suppliers error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch suppliers' });
  }
});

/**
 * GET /api/v1/suppliers/:id
 * Get single supplier with purchase history summary and ledger
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const supplierId = String(req.params.id);

  try {
    const supRes = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
    if (supRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Supplier not found' });
    }
    const supplier = supRes.rows[0];

    // Fetch recent ledger entries
    const ledgerRes = await pool.query(
      `SELECT id, entry_type, amount, balance_after, ref_type, ref_id, created_at
       FROM supplier_ledger
       WHERE supplier_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [supplierId]
    );

    return res.json({
      supplier: {
        id: supplier.id,
        name: supplier.name,
        phone: supplier.phone,
        address: supplier.address,
        outstandingBalance: supplier.outstanding_balance,
        isActive: supplier.is_active,
        createdAt: supplier.created_at,
        updatedAt: supplier.updated_at,
        recentLedger: ledgerRes.rows.map((l) => ({
          id: l.id,
          entryType: l.entry_type,
          amount: l.amount,
          balanceAfter: l.balance_after,
          refType: l.ref_type,
          refId: l.ref_id,
          createdAt: l.created_at
        }))
      }
    });
  } catch (error) {
    console.error('Get supplier error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch supplier details' });
  }
});

/**
 * POST /api/v1/suppliers
 * Create new supplier
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = createSupplierSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { name, phone, address, outstandingBalance } = parseResult.data;

  try {
    const insertRes = await pool.query(
      `INSERT INTO suppliers (name, phone, address, outstanding_balance, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [name, phone || null, address || null, outstandingBalance]
    );

    const newSupplier = insertRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'SUPPLIER_CREATE',
      entity: 'SUPPLIER',
      entityId: newSupplier.id,
      afterState: newSupplier,
      ipAddress
    });

    return res.status(201).json({
      message: 'Supplier created successfully',
      supplier: newSupplier
    });
  } catch (error) {
    console.error('Create supplier error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create supplier' });
  }
});

/**
 * PUT /api/v1/suppliers/:id
 * Update supplier details
 */
router.put('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const supplierId = String(req.params.id);
  const parseResult = updateSupplierSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const data = parseResult.data;

  try {
    const existing = await pool.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Supplier not found' });
    }
    const beforeSupplier = existing.rows[0];

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) { updates.push(`name = $${idx++}`); values.push(data.name); }
    if (data.phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(data.phone); }
    if (data.address !== undefined) { updates.push(`address = $${idx++}`); values.push(data.address); }
    if (data.isActive !== undefined) { updates.push(`is_active = $${idx++}`); values.push(data.isActive); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'NO_CHANGES', message: 'No fields provided to update' });
    }

    values.push(supplierId);

    const updateQuery = `
      UPDATE suppliers
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const updateRes = await pool.query(updateQuery, values);
    const updatedSupplier = updateRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'SUPPLIER_UPDATE',
      entity: 'SUPPLIER',
      entityId: supplierId,
      beforeState: beforeSupplier,
      afterState: updatedSupplier,
      ipAddress
    });

    return res.json({
      message: 'Supplier updated successfully',
      supplier: updatedSupplier
    });
  } catch (error) {
    console.error('Update supplier error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update supplier' });
  }
});

/**
 * PATCH /api/v1/suppliers/:id/status
 * Toggle supplier active status
 */
router.patch('/:id/status', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const supplierId = String(req.params.id);

  try {
    const existing = await pool.query('SELECT id, name, is_active FROM suppliers WHERE id = $1', [supplierId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Supplier not found' });
    }

    const currentStatus = existing.rows[0].is_active;
    const newStatus = req.body.isActive !== undefined ? Boolean(req.body.isActive) : !currentStatus;

    const resUpdate = await pool.query(
      `UPDATE suppliers SET is_active = $1 WHERE id = $2 RETURNING id, name, is_active`,
      [newStatus, supplierId]
    );

    await logAudit({
      userId: req.user!.id,
      action: 'SUPPLIER_STATUS_CHANGE',
      entity: 'SUPPLIER',
      entityId: supplierId,
      beforeState: { isActive: currentStatus },
      afterState: { isActive: newStatus },
      ipAddress
    });

    return res.json({
      message: `Supplier ${newStatus ? 'activated' : 'deactivated'} successfully`,
      supplier: resUpdate.rows[0]
    });
  } catch (error) {
    console.error('Supplier status error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to toggle supplier status' });
  }
});

const supplierPaymentSchema = z.object({
  amount: z.number().positive('Payment amount must be greater than 0'),
  paymentMethod: z.enum(['cash', 'bank_transfer', 'cheque']),
  referenceNo: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  allowOverpayment: z.boolean().optional().default(false)
});

/**
 * POST /api/v1/suppliers/:id/payments
 * Settle supplier balance in ONE atomic DB transaction
 */
router.post('/:id/payments', async (req: AuthenticatedRequest, res: Response) => {
  const supplierId = String(req.params.id);
  const ipAddress = getClientIp(req);
  const parseResult = supplierPaymentSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { amount, paymentMethod, referenceNo, notes, allowOverpayment } = parseResult.data;
  const userId = req.user!.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock supplier
    const supRes = await client.query(
      `SELECT id, name, outstanding_balance FROM suppliers WHERE id = $1 FOR UPDATE`,
      [supplierId]
    );

    if (supRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Supplier not found' });
    }

    const supplier = supRes.rows[0];
    const prevBalance = Number(supplier.outstanding_balance);
    const balanceAfter = Math.round((prevBalance - amount) * 100) / 100;

    // Check negative balance
    if (balanceAfter < 0 && !allowOverpayment) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'OVERPAYMENT_NOT_ALLOWED',
        message: `Payment of Rs. ${amount.toFixed(2)} exceeds outstanding balance of Rs. ${prevBalance.toFixed(2)}. Set allowOverpayment to true to record an advance or overpayment.`
      });
    }

    // 2. Insert into supplier_payments
    const payRes = await client.query(
      `INSERT INTO supplier_payments (
         supplier_id, amount, payment_method, reference_no, notes, paid_by
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, amount, payment_method, reference_no, notes, created_at`,
      [supplierId, amount, paymentMethod, referenceNo || null, notes || null, userId]
    );
    const payment = payRes.rows[0];

    // 3. Insert into supplier_ledger (payment reduces payable: negative amount)
    await client.query(
      `INSERT INTO supplier_ledger (
         supplier_id, entry_type, amount, balance_after, ref_type, ref_id, created_by
       ) VALUES ($1, 'payment', $2, $3, 'supplier_payment', $4, $5)`,
      [supplierId, -amount, balanceAfter, payment.id, userId]
    );

    // 4. Audit log in same transaction
    await logAuditWithClient(client, {
      userId,
      action: 'SUPPLIER_PAYMENT_CREATED',
      entity: 'SUPPLIER_PAYMENT',
      entityId: payment.id,
      beforeState: { outstandingBalance: prevBalance },
      afterState: {
        paymentId: payment.id,
        amount,
        paymentMethod,
        referenceNo,
        balanceAfter
      },
      ipAddress
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Supplier payment recorded successfully',
      payment: {
        id: payment.id,
        supplierId,
        supplierName: supplier.name,
        amount: payment.amount,
        paymentMethod: payment.payment_method,
        referenceNo: payment.reference_no,
        notes: payment.notes,
        previousBalance: prevBalance,
        newBalance: balanceAfter,
        createdAt: payment.created_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Supplier payment error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to record supplier payment' });
  } finally {
    client.release();
  }
});

export { router as supplierRouter };

