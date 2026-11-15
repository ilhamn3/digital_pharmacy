import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { logAudit, logAuditWithClient } from '../services/audit.service.js';

export const holdBillRouter = Router();

// All hold-bill operations require authentication
holdBillRouter.use(authenticate);

function getClientIp(req: AuthenticatedRequest): string {
  return (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
}

const holdBillItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive(),
  discountAmount: z.number().min(0).default(0)
});

const createHoldBillSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  customerName: z.string().max(150).optional().nullable(),
  doctorName: z.string().max(100).optional().nullable(),
  patientName: z.string().max(100).optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z.array(holdBillItemSchema).min(1, 'Held cart must contain at least one item')
});

/**
 * POST /api/v1/hold-bills
 * Holds an uncompleted POS cart:
 * - Does NOT reserve inventory or lock batch prices
 * - Persists cart structure for later resumption or checkout
 */
holdBillRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user!.id;
  const ipAddress = getClientIp(req);

  const parseResult = createHoldBillSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const {
    customerId,
    customerName,
    doctorName,
    patientName,
    notes,
    items
  } = parseResult.data;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verify all products exist and are active
    const productIds = Array.from(new Set(items.map((i) => i.productId)));
    const prodRes = await client.query(
      `SELECT id, name, is_active FROM products WHERE id = ANY($1)`,
      [productIds]
    );

    const prodMap = new Map<string, any>();
    for (const p of prodRes.rows) {
      prodMap.set(p.id, p);
    }

    for (const item of items) {
      const prod = prodMap.get(item.productId);
      if (!prod) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'PRODUCT_NOT_FOUND',
          message: `Product with ID '${item.productId}' not found.`
        });
      }
      if (!prod.is_active) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'PRODUCT_INACTIVE',
          message: `Product '${prod.name}' is inactive and cannot be added to a held bill.`
        });
      }
    }

    // 2. Generate unique hold reference: HOLD-YYYYMMDD-XXXX
    const holdReference = `HOLD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    // 3. Insert into hold_bills
    const holdRes = await client.query(
      `INSERT INTO hold_bills (
         hold_reference, customer_id, customer_name, doctor_name, patient_name, notes, status, held_by
       ) VALUES ($1, $2, $3, $4, $5, $6, 'held', $7)
       RETURNING *`,
      [
        holdReference,
        customerId || null,
        customerName || null,
        doctorName || null,
        patientName || null,
        notes || null,
        userId
      ]
    );
    const holdBill = holdRes.rows[0];

    // 4. Insert hold_bill_items (estimate unit_price using earliest active batch MRP or 0.00 without stock deduction)
    const insertedItems = [];
    for (const item of items) {
      const batchRes = await client.query(
        `SELECT mrp FROM batches 
         WHERE product_id = $1 AND is_active = true AND current_quantity > 0 AND expiry_date >= CURRENT_DATE 
         ORDER BY expiry_date ASC LIMIT 1`,
        [item.productId]
      );
      const estUnitPrice = batchRes.rows[0]?.mrp ? Number(batchRes.rows[0].mrp) : 0.00;

      const itemRes = await client.query(
        `INSERT INTO hold_bill_items (
           hold_bill_id, product_id, quantity, unit_price, discount_amount
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [holdBill.id, item.productId, item.quantity, estUnitPrice, item.discountAmount]
      );

      insertedItems.push({
        ...itemRes.rows[0],
        product_name: prodMap.get(item.productId).name
      });
    }

    // 5. Audit log
    await logAuditWithClient(client, {
      userId,
      action: 'HOLD_BILL_CREATED',
      entity: 'HOLD_BILL',
      entityId: holdBill.id,
      afterState: {
        holdReference,
        itemCount: items.length,
        customerName
      },
      ipAddress
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Bill held successfully',
      holdBill: {
        id: holdBill.id,
        holdReference: holdBill.hold_reference,
        customerId: holdBill.customer_id,
        customerName: holdBill.customer_name,
        doctorName: holdBill.doctor_name,
        patientName: holdBill.patient_name,
        notes: holdBill.notes,
        status: holdBill.status,
        heldBy: holdBill.held_by,
        createdAt: holdBill.created_at,
        items: insertedItems.map((i) => ({
          id: i.id,
          productId: i.product_id,
          productName: i.product_name,
          quantity: Number(i.quantity),
          unitPrice: Number(i.unit_price),
          discountAmount: Number(i.discount_amount)
        }))
      }
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Create hold bill error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to hold bill' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/hold-bills
 * List all active held bills
 */
holdBillRouter.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const listRes = await pool.query(
      `SELECT 
         hb.*,
         u.username as held_by_username,
         COUNT(hbi.id) as item_count
       FROM hold_bills hb
       JOIN users u ON hb.held_by = u.id
       LEFT JOIN hold_bill_items hbi ON hb.id = hbi.hold_bill_id
       WHERE hb.status = 'held'
       GROUP BY hb.id, u.username
       ORDER BY hb.created_at DESC`
    );

    const heldBills = listRes.rows.map((r) => ({
      id: r.id,
      holdReference: r.hold_reference,
      customerId: r.customer_id,
      customerName: r.customer_name,
      doctorName: r.doctor_name,
      patientName: r.patient_name,
      notes: r.notes,
      status: r.status,
      heldBy: r.held_by,
      heldByUsername: r.held_by_username,
      itemCount: parseInt(r.item_count, 10),
      createdAt: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString()
    }));

    return res.json({ holdBills: heldBills });
  } catch (error: any) {
    console.error('List hold bills error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list held bills' });
  }
});

/**
 * GET /api/v1/hold-bills/:id/resume
 * Retrieves held cart and reprices against current active stock (does not reserve stock)
 */
holdBillRouter.get('/:id/resume', async (req: AuthenticatedRequest, res: Response) => {
  const holdBillId = String(req.params.id);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const hbRes = await client.query(
      `SELECT * FROM hold_bills WHERE id = $1 FOR UPDATE`,
      [holdBillId]
    );

    if (hbRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Held bill not found' });
    }

    const holdBill = hbRes.rows[0];

    if (holdBill.status !== 'held') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'INVALID_STATUS',
        message: `Held bill has status '${holdBill.status}' and cannot be resumed.`
      });
    }

    // Fetch items
    const itemsRes = await client.query(
      `SELECT hbi.*, p.name as product_name, p.is_rx_required, p.allow_fractional_qty
       FROM hold_bill_items hbi
       JOIN products p ON hbi.product_id = p.id
       WHERE hbi.hold_bill_id = $1
       ORDER BY hbi.created_at ASC`,
      [holdBillId]
    );

    // Re-price and check current stock availability for each item
    const repricedItems = [];
    let allAvailable = true;

    for (const item of itemsRes.rows) {
      const requestedQty = Number(item.quantity);

      // Query available batches
      const batchRes = await client.query(
        `SELECT id, batch_no, mrp, current_quantity, expiry_date
         FROM batches
         WHERE product_id = $1 
           AND is_active = true 
           AND current_quantity > 0 
           AND expiry_date >= CURRENT_DATE
         ORDER BY expiry_date ASC`,
        [item.product_id]
      );

      let availableStock = 0;
      let currentMrp = 0;
      if (batchRes.rows.length > 0) {
        availableStock = batchRes.rows.reduce((sum, b) => sum + Number(b.current_quantity), 0);
        currentMrp = Number(batchRes.rows[0].mrp);
      }

      const isSufficient = availableStock >= requestedQty;
      if (!isSufficient) {
        allAvailable = false;
      }

      const heldPrice = Number(item.unit_price);
      const isPriceChanged = Number(currentMrp) !== heldPrice;

      repricedItems.push({
        id: item.id,
        productId: item.product_id,
        productName: item.product_name,
        isRxRequired: item.is_rx_required,
        allowFractionalQty: item.allow_fractional_qty,
        quantity: requestedQty,
        discountAmount: Number(item.discount_amount),
        currentMrp,
        heldPrice,
        priceChanged: isPriceChanged,
        availableStock,
        isAvailable: isSufficient
      });
    }

    // Mark as resumed
    await client.query(
      `UPDATE hold_bills SET status = 'resumed', updated_at = NOW() WHERE id = $1`,
      [holdBillId]
    );

    await client.query('COMMIT');

    return res.json({
      message: 'Held bill resumed and cart repriced against current stock',
      holdBill: {
        id: holdBill.id,
        holdReference: holdBill.hold_reference,
        customerId: holdBill.customer_id,
        customerName: holdBill.customer_name,
        doctorName: holdBill.doctor_name,
        patientName: holdBill.patient_name,
        notes: holdBill.notes,
        status: 'resumed',
        allStockAvailable: allAvailable,
        items: repricedItems
      }
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Resume hold bill error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to resume held bill' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/v1/hold-bills/:id/discard
 * Discard a held bill
 */
holdBillRouter.post('/:id/discard', async (req: AuthenticatedRequest, res: Response) => {
  const holdBillId = String(req.params.id);
  const userId = req.user!.id;
  const ipAddress = getClientIp(req);

  try {
    const updateRes = await pool.query(
      `UPDATE hold_bills 
       SET status = 'discarded', updated_at = NOW() 
       WHERE id = $1 AND status = 'held'
       RETURNING id, hold_reference`,
      [holdBillId]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Held bill not found or is no longer in held status'
      });
    }

    await logAudit({
      userId,
      action: 'HOLD_BILL_DISCARDED',
      entity: 'HOLD_BILL',
      entityId: holdBillId,
      afterState: { holdReference: updateRes.rows[0].hold_reference },
      ipAddress
    });

    return res.json({
      message: 'Held bill discarded successfully',
      holdBillId
    });
  } catch (error: any) {
    console.error('Discard hold bill error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to discard held bill' });
  }
});
