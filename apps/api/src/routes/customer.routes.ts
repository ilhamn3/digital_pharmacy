import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

// Validation Schemas
const createCustomerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  phone: z.string().optional().nullable(),
  creditLimit: z.number().min(0, 'Credit limit must be non-negative').default(0)
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().optional().nullable(),
  creditLimit: z.number().min(0).optional(),
  isActive: z.boolean().optional()
});

/**
 * GET /api/v1/customers
 * List/search customers (Cashier, Pharmacist, Owner)
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
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
      `SELECT COUNT(*) FROM customers ${whereClause}`,
      values.slice(0, idx - 1)
    );
    const total = parseInt(countRes.rows[0].count, 10);

    const query = `
      SELECT 
        id,
        name,
        phone,
        credit_balance,
        credit_limit,
        is_active,
        created_at,
        updated_at
      FROM customers
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
      customers: result.rows.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        creditBalance: c.credit_balance,
        creditLimit: c.credit_limit,
        isActive: c.is_active,
        createdAt: c.created_at,
        updatedAt: c.updated_at
      }))
    });
  } catch (error) {
    console.error('List customers error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch customers' });
  }
});

/**
 * GET /api/v1/customers/:id
 * Get single customer with credit balance and ledger history
 */
router.get('/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const customerId = String(req.params.id);

  try {
    const custRes = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    if (custRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
    }

    const customer = custRes.rows[0];

    // Recent ledger entries
    const ledgerRes = await pool.query(
      `SELECT 
         id, entry_type, amount, balance_after, ref_type, ref_id, created_at
       FROM customer_ledger
       WHERE customer_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [customerId]
    );

    return res.json({
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        creditBalance: customer.credit_balance,
        creditLimit: customer.credit_limit,
        isActive: customer.is_active,
        createdAt: customer.created_at,
        updatedAt: customer.updated_at,
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
    console.error('Get customer error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch customer' });
  }
});

/**
 * POST /api/v1/customers
 * Create customer (Cashier can create with creditLimit = 0; Owner/Pharmacist can set creditLimit)
 */
router.post('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = createCustomerSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const data = parseResult.data;

  // Cashiers can never grant a non-zero credit limit
  if (req.user?.role === 'cashier' && data.creditLimit > 0) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Cashiers are not authorized to assign credit limits. Only Owners or Pharmacists may set credit limits.'
    });
  }

  try {
    const insertRes = await pool.query(
      `INSERT INTO customers (name, phone, credit_balance, credit_limit, is_active)
       VALUES ($1, $2, 0.00, $3, true)
       RETURNING *`,
      [data.name.trim(), data.phone?.trim() || null, data.creditLimit]
    );

    const newCustomer = insertRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'CUSTOMER_CREATE',
      entity: 'CUSTOMER',
      entityId: newCustomer.id,
      afterState: newCustomer,
      ipAddress
    });

    return res.status(201).json({
      message: 'Customer created successfully',
      customer: {
        id: newCustomer.id,
        name: newCustomer.name,
        phone: newCustomer.phone,
        creditBalance: newCustomer.credit_balance,
        creditLimit: newCustomer.credit_limit,
        isActive: newCustomer.is_active,
        createdAt: newCustomer.created_at
      }
    });
  } catch (error: any) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'PHONE_EXISTS',
        message: 'A customer with this phone number already exists'
      });
    }
    console.error('Create customer error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create customer' });
  }
});

/**
 * PUT /api/v1/customers/:id
 * Update customer (Cashiers cannot modify creditLimit)
 */
router.put('/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const customerId = String(req.params.id);
  const parseResult = updateCustomerSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const data = parseResult.data;

  if (req.user?.role === 'cashier' && data.creditLimit !== undefined) {
    return res.status(403).json({
      error: 'FORBIDDEN',
      message: 'Cashiers are not permitted to change customer credit limits'
    });
  }

  try {
    const existingRes = await pool.query('SELECT * FROM customers WHERE id = $1', [customerId]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
    }

    const beforeCustomer = existingRes.rows[0];

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) {
      updates.push(`name = $${idx++}`);
      values.push(data.name.trim());
    }
    if (data.phone !== undefined) {
      updates.push(`phone = $${idx++}`);
      values.push(data.phone?.trim() || null);
    }
    if (data.creditLimit !== undefined) {
      updates.push(`credit_limit = $${idx++}`);
      values.push(data.creditLimit);
    }
    if (data.isActive !== undefined) {
      if (req.user?.role === 'cashier') {
        return res.status(403).json({ error: 'FORBIDDEN', message: 'Cashiers cannot modify customer active status' });
      }
      updates.push(`is_active = $${idx++}`);
      values.push(data.isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'NO_CHANGES', message: 'No fields provided to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(customerId);

    const updateQuery = `
      UPDATE customers
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const updateRes = await pool.query(updateQuery, values);
    const updatedCustomer = updateRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'CUSTOMER_UPDATE',
      entity: 'CUSTOMER',
      entityId: customerId,
      beforeState: beforeCustomer,
      afterState: updatedCustomer,
      ipAddress
    });

    return res.json({
      message: 'Customer updated successfully',
      customer: {
        id: updatedCustomer.id,
        name: updatedCustomer.name,
        phone: updatedCustomer.phone,
        creditBalance: updatedCustomer.credit_balance,
        creditLimit: updatedCustomer.credit_limit,
        isActive: updatedCustomer.is_active,
        updatedAt: updatedCustomer.updated_at
      }
    });
  } catch (error) {
    console.error('Update customer error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update customer' });
  }
});

/**
 * PATCH /api/v1/customers/:id/status
 * Toggle customer active status (Owner / Pharmacist only)
 */
router.patch('/:id/status', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const customerId = String(req.params.id);

  try {
    const existing = await pool.query('SELECT id, is_active FROM customers WHERE id = $1', [customerId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Customer not found' });
    }

    const currentStatus = existing.rows[0].is_active;
    const newStatus = req.body.isActive !== undefined ? Boolean(req.body.isActive) : !currentStatus;

    const resUpdate = await pool.query(
      `UPDATE customers SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active`,
      [newStatus, customerId]
    );

    await logAudit({
      userId: req.user!.id,
      action: 'CUSTOMER_STATUS_CHANGE',
      entity: 'CUSTOMER',
      entityId: customerId,
      beforeState: { isActive: currentStatus },
      afterState: { isActive: newStatus },
      ipAddress
    });

    return res.json({
      message: `Customer ${newStatus ? 'activated' : 'deactivated'} successfully`,
      customer: resUpdate.rows[0]
    });
  } catch (error) {
    console.error('Customer status error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to toggle customer status' });
  }
});

export { router as customerRouter };
