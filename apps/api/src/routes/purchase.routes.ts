import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { logAuditWithClient } from '../services/audit.service.js';

const router = Router();

// Purchases (GRN) are strictly restricted to Owner and Pharmacist (Cashier gets 403 Forbidden)
router.use(authenticate, requireRoles('owner', 'pharmacist'));

// Schema for GRN Line Item
const purchaseItemSchema = z.object({
  productId: z.string().uuid('Valid product ID is required'),
  batchNo: z.string().min(1, 'Batch number is required').trim(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expiry date must be in YYYY-MM-DD format'),
  packsReceived: z.number().positive('Packs received must be greater than 0'),
  packCost: z.number().min(0, 'Pack cost must be non-negative'),
  packSize: z.number().int().positive('Pack size must be at least 1').optional(),
  mrp: z.number().min(0, 'MRP must be non-negative'),
  overrideExpiry: z.boolean().optional(),
  overrideReason: z.string().optional()
});

const createPurchaseSchema = z.object({
  supplierId: z.string().uuid('Valid supplier ID is required'),
  invoiceNo: z.string().min(1, 'Invoice number is required').trim(),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Purchase date must be in YYYY-MM-DD format'),
  notes: z.string().optional(),
  items: z.array(purchaseItemSchema).min(1, 'Purchase must contain at least one item')
});

const voidPurchaseSchema = z.object({
  reason: z.string().min(3, 'Void reason is mandatory and must be at least 3 characters long').trim()
});

/**
 * POST /api/v1/purchases
 * Create Goods Received Note (GRN) in ONE atomic DB transaction
 */
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = createPurchaseSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { supplierId, invoiceNo, purchaseDate, notes, items } = parseResult.data;
  const userId = req.user!.id;
  const userRole = req.user!.role;

  // Validation Phase: duplicate invoice check
  const duplicateCheck = await pool.query(
    `SELECT id FROM purchases WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status = 'received'`,
    [supplierId, invoiceNo]
  );
  if (duplicateCheck.rows.length > 0) {
    return res.status(409).json({
      error: 'DUPLICATE_INVOICE',
      message: `Purchase invoice '${invoiceNo}' already exists for this supplier`
    });
  }

  // Expiry date and MRP validations
  const warnings: string[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const expiry = new Date(item.expiryDate);
    const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) {
      if (userRole !== 'owner' || !item.overrideExpiry || !item.overrideReason) {
        return res.status(400).json({
          error: 'EXPIRED_BATCH_REJECTED',
          message: `Batch '${item.batchNo}' has already expired (${item.expiryDate}). Expired batches are rejected unless overridden by an owner with a documented reason.`
        });
      }
      warnings.push(`Batch '${item.batchNo}' is already expired (${item.expiryDate}) - owner override applied: ${item.overrideReason}`);
    } else if (diffDays <= 90) {
      warnings.push(`Batch '${item.batchNo}' expires in ${diffDays} days (${item.expiryDate})`);
    }
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock supplier row
    const supRes = await client.query(
      `SELECT id, name, outstanding_balance FROM suppliers WHERE id = $1 FOR UPDATE`,
      [supplierId]
    );
    if (supRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Supplier not found' });
    }
    const supplier = supRes.rows[0];

    // 2. Pre-calculate line totals and purchase total
    interface ProcessedItem {
      productId: string;
      productName: string;
      batchNo: string;
      expiryDate: string;
      packsReceived: number;
      packCost: number;
      packSizeSnapshot: number;
      unitCostPrice: number;
      quantity: number;
      mrp: number;
      lineTotal: number;
    }

    const processedItems: ProcessedItem[] = [];
    let grandTotal = 0;

    for (const item of items) {
      const prodRes = await client.query(
        `SELECT id, name, pack_size FROM products WHERE id = $1`,
        [item.productId]
      );
      if (prodRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'NOT_FOUND', message: `Product not found: ${item.productId}` });
      }
      const product = prodRes.rows[0];

      const packSizeSnapshot = item.packSize || product.pack_size || 1;
      const quantity = Math.round(item.packsReceived * packSizeSnapshot * 100) / 100;
      
      // Unit cost: ROUND(pack_cost / pack_size, 4)
      const unitCostPrice = Math.round((item.packCost / packSizeSnapshot) * 10000) / 10000;

      // Line total: ROUND(packs_received * pack_cost, 2)
      const lineTotal = Math.round(item.packsReceived * item.packCost * 100) / 100;
      grandTotal = Math.round((grandTotal + lineTotal) * 100) / 100;

      // MRP below cost warning flag
      if (item.mrp < unitCostPrice) {
        warnings.push(`Batch '${item.batchNo}': MRP (Rs. ${item.mrp.toFixed(2)}) is below unit cost (Rs. ${unitCostPrice.toFixed(4)})`);
      }

      processedItems.push({
        productId: item.productId,
        productName: product.name,
        batchNo: item.batchNo,
        expiryDate: item.expiryDate,
        packsReceived: item.packsReceived,
        packCost: item.packCost,
        packSizeSnapshot,
        unitCostPrice,
        quantity,
        mrp: item.mrp,
        lineTotal
      });
    }

    // 3. Insert Purchase
    const purchaseRes = await client.query(
      `INSERT INTO purchases (supplier_id, invoice_no, purchase_date, total_amount, status, notes, created_by)
       VALUES ($1, $2, $3, $4, 'received', $5, $6)
       RETURNING id, supplier_id, invoice_no, purchase_date, total_amount, status, created_at`,
      [supplierId, invoiceNo, purchaseDate, grandTotal, notes || null, userId]
    );
    const purchase = purchaseRes.rows[0];

    const createdBatches = [];

    // 4. Create batches, purchase_items, and stock_movements
    for (const pItem of processedItems) {
      // Create a NEW batch row (current_quantity starts at 0.00; populated solely via stock_movements trigger)
      const batchRes = await client.query(
        `INSERT INTO batches (
           product_id, supplier_id, batch_no, expiry_date, cost_price, mrp,
           initial_quantity, current_quantity, is_active
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 0.00, true
         ) RETURNING id, batch_no, expiry_date, cost_price, mrp`,
        [
          pItem.productId,
          supplierId,
          pItem.batchNo,
          pItem.expiryDate,
          pItem.unitCostPrice,
          pItem.mrp,
          pItem.quantity
        ]
      );
      const batch = batchRes.rows[0];

      // Insert purchase item snapshot
      await client.query(
        `INSERT INTO purchase_items (
           purchase_id, product_id, batch_id, batch_no, expiry_date,
           pack_size_snapshot, packs_received, pack_cost,
           quantity, cost_price, mrp, line_total
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          purchase.id,
          pItem.productId,
          batch.id,
          pItem.batchNo,
          pItem.expiryDate,
          pItem.packSizeSnapshot,
          pItem.packsReceived,
          pItem.packCost,
          pItem.quantity,
          pItem.unitCostPrice,
          pItem.mrp,
          pItem.lineTotal
        ]
      );

      // Insert stock movement (triggers apply_stock_movement_to_batch which updates batches.current_quantity)
      await client.query(
        `INSERT INTO stock_movements (
           batch_id, movement_type, qty_change, ref_type, ref_id, created_by
         ) VALUES ($1, 'purchase', $2, 'purchase', $3, $4)`,
        [batch.id, pItem.quantity, purchase.id, userId]
      );

      createdBatches.push({
        batchId: batch.id,
        batchNo: batch.batch_no,
        productName: pItem.productName,
        quantity: pItem.quantity,
        unitCostPrice: pItem.unitCostPrice,
        lineTotal: pItem.lineTotal
      });
    }

    // 5. Insert supplier ledger entry (purchase_credit increases payable)
    const prevBalance = Number(supplier.outstanding_balance);
    const balanceAfter = Math.round((prevBalance + grandTotal) * 100) / 100;

    await client.query(
      `INSERT INTO supplier_ledger (
         supplier_id, entry_type, amount, balance_after, ref_type, ref_id, created_by
       ) VALUES ($1, 'purchase_credit', $2, $3, 'purchase', $4, $5)`,
      [supplierId, grandTotal, balanceAfter, purchase.id, userId]
    );

    // 6. Write audit log in the same transaction using the same client
    await logAuditWithClient(client, {
      userId,
      action: 'PURCHASE_CREATED',
      entity: 'PURCHASE',
      entityId: purchase.id,
      afterState: {
        invoiceNo,
        supplierId,
        supplierName: supplier.name,
        totalAmount: grandTotal,
        itemCount: processedItems.length,
        batchesCreated: createdBatches.map((b) => b.batchId)
      },
      ipAddress
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Goods Received Note (GRN) created successfully',
      purchase: {
        id: purchase.id,
        invoiceNo: purchase.invoice_no,
        purchaseDate: purchase.purchase_date,
        totalAmount: purchase.total_amount,
        status: purchase.status,
        supplierId,
        supplierName: supplier.name,
        previousSupplierBalance: prevBalance,
        newSupplierBalance: balanceAfter,
        createdAt: purchase.created_at
      },
      items: createdBatches,
      warnings
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'DUPLICATE_INVOICE',
        message: 'An active received invoice with this number already exists for this supplier'
      });
    }
    console.error('Create purchase error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create purchase' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/v1/purchases
 * List purchases with pagination and filters
 */
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 100);
    const offset = parseInt(String(req.query.offset || '0'), 10);
    const supplierId = req.query.supplierId ? String(req.query.supplierId) : null;
    const status = req.query.status ? String(req.query.status) : null;
    const startDate = req.query.startDate ? String(req.query.startDate) : null;
    const endDate = req.query.endDate ? String(req.query.endDate) : null;

    const whereClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (supplierId) {
      whereClauses.push(`p.supplier_id = $${idx++}`);
      values.push(supplierId);
    }
    if (status) {
      whereClauses.push(`p.status = $${idx++}`);
      values.push(status);
    }
    if (startDate) {
      whereClauses.push(`p.purchase_date >= $${idx++}`);
      values.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`p.purchase_date <= $${idx++}`);
      values.push(endDate);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::INT as total FROM purchases p ${whereSql}`,
      values
    );
    const total = countRes.rows[0].total;

    const listQuery = `
      SELECT 
        p.id,
        p.supplier_id,
        s.name as supplier_name,
        p.invoice_no,
        p.purchase_date,
        p.total_amount,
        p.status,
        p.void_reason,
        p.voided_at,
        p.created_at,
        COUNT(pi.id)::INT as item_count
      FROM purchases p
      JOIN suppliers s ON p.supplier_id = s.id
      LEFT JOIN purchase_items pi ON p.id = pi.purchase_id
      ${whereSql}
      GROUP BY p.id, s.name
      ORDER BY p.purchase_date DESC, p.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;
    values.push(limit, offset);

    const listRes = await pool.query(listQuery, values);

    return res.json({
      total,
      limit,
      offset,
      purchases: listRes.rows.map((row) => ({
        id: row.id,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        invoiceNo: row.invoice_no,
        purchaseDate: row.purchase_date,
        totalAmount: row.total_amount,
        status: row.status,
        voidReason: row.void_reason,
        voidedAt: row.voided_at,
        createdAt: row.created_at,
        itemCount: row.item_count
      }))
    });
  } catch (error) {
    console.error('List purchases error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list purchases' });
  }
});

/**
 * GET /api/v1/purchases/:id
 * Get single purchase details with line items
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  const purchaseId = String(req.params.id);

  try {
    const purchaseRes = await pool.query(
      `SELECT 
         p.*,
         s.name as supplier_name,
         u.full_name as created_by_name,
         vu.full_name as voided_by_name
       FROM purchases p
       JOIN suppliers s ON p.supplier_id = s.id
       JOIN users u ON p.created_by = u.id
       LEFT JOIN users vu ON p.voided_by = vu.id
       WHERE p.id = $1`,
      [purchaseId]
    );

    if (purchaseRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Purchase not found' });
    }

    const purchase = purchaseRes.rows[0];

    const itemsRes = await pool.query(
      `SELECT 
         pi.*,
         pr.name as product_name,
         pr.unit as product_unit,
         b.current_quantity as batch_current_quantity
       FROM purchase_items pi
       JOIN products pr ON pi.product_id = pr.id
       JOIN batches b ON pi.batch_id = b.id
       WHERE pi.purchase_id = $1
       ORDER BY pi.created_at ASC`,
      [purchaseId]
    );

    return res.json({
      purchase: {
        id: purchase.id,
        supplierId: purchase.supplier_id,
        supplierName: purchase.supplier_name,
        invoiceNo: purchase.invoice_no,
        purchaseDate: purchase.purchase_date,
        totalAmount: purchase.total_amount,
        status: purchase.status,
        notes: purchase.notes,
        voidReason: purchase.void_reason,
        voidedBy: purchase.voided_by_name,
        voidedAt: purchase.voided_at,
        createdBy: purchase.created_by_name,
        createdAt: purchase.created_at
      },
      items: itemsRes.rows.map((i) => ({
        id: i.id,
        productId: i.product_id,
        productName: i.product_name,
        batchId: i.batch_id,
        batchNo: i.batch_no,
        expiryDate: i.expiry_date,
        packSizeSnapshot: i.pack_size_snapshot,
        packsReceived: i.packs_received,
        packCost: i.pack_cost,
        quantity: i.quantity,
        costPrice: i.cost_price,
        mrp: i.mrp,
        lineTotal: i.line_total,
        batchCurrentQuantity: i.batch_current_quantity
      }))
    });
  } catch (error) {
    console.error('Get purchase error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve purchase' });
  }
});

/**
 * POST /api/v1/purchases/:id/void
 * Void a purchase in ONE atomic DB transaction:
 * - Blocked if any batch has been sold or reduced below received quantity
 * - Reverses stock via stock_movements ('void')
 * - Reverses supplier balance via supplier_ledger ('return_debit')
 * - Marks purchase voided with mandatory reason and audit log
 */
router.post('/:id/void', async (req: AuthenticatedRequest, res: Response) => {
  const purchaseId = String(req.params.id);
  const ipAddress = getClientIp(req);
  const parseResult = voidPurchaseSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { reason } = parseResult.data;
  const userId = req.user!.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock purchase
    const purRes = await client.query(
      `SELECT * FROM purchases WHERE id = $1 FOR UPDATE`,
      [purchaseId]
    );

    if (purRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Purchase not found' });
    }

    const purchase = purRes.rows[0];

    if (purchase.status === 'voided') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ALREADY_VOIDED', message: 'Purchase has already been voided' });
    }

    // 2. Lock supplier
    const supRes = await client.query(
      `SELECT id, name, outstanding_balance FROM suppliers WHERE id = $1 FOR UPDATE`,
      [purchase.supplier_id]
    );
    const supplier = supRes.rows[0];

    // 3. Lock all purchase items and associated batches
    const itemsRes = await client.query(
      `SELECT 
         pi.id, pi.batch_id, pi.batch_no, pi.quantity as received_quantity,
         b.current_quantity, b.is_active, p.name as product_name
       FROM purchase_items pi
       JOIN batches b ON pi.batch_id = b.id
       JOIN products p ON pi.product_id = p.id
       WHERE pi.purchase_id = $1
       FOR UPDATE OF b`,
      [purchaseId]
    );

    const batchIds = itemsRes.rows.map((i) => i.batch_id);

    // 4a. Check if any batch has subsequent stock movements other than the initial purchase movement
    const movRes = await client.query(
      `SELECT sm.id, sm.batch_id, sm.movement_type, sm.qty_change, sm.ref_type, b.batch_no, p.name as product_name
       FROM stock_movements sm
       JOIN batches b ON sm.batch_id = b.id
       JOIN products p ON b.product_id = p.id
       WHERE sm.batch_id = ANY($1)
         AND NOT (sm.ref_type = 'purchase' AND sm.ref_id = $2)`,
      [batchIds, purchaseId]
    );

    const offendingMovements = movRes.rows.map((r) => ({
      batchId: r.batch_id,
      batchNo: r.batch_no,
      productName: r.product_name,
      movementType: r.movement_type,
      qtyChange: r.qty_change,
      refType: r.ref_type
    }));

    // 4b. Check if any supplier_payments reference this purchase
    const payRes = await client.query(
      `SELECT id, amount, payment_method, reference_no, created_at
       FROM supplier_payments
       WHERE purchase_id = $1`,
      [purchaseId]
    );

    const offendingPayments = payRes.rows.map((p) => ({
      paymentId: p.id,
      amount: p.amount,
      paymentMethod: p.payment_method,
      referenceNo: p.reference_no,
      createdAt: p.created_at
    }));

    // 4c. Verify stock depletion
    const depletedBatches = [];
    for (const item of itemsRes.rows) {
      const currentQty = Number(item.current_quantity);
      const receivedQty = Number(item.received_quantity);
      if (currentQty < receivedQty) {
        depletedBatches.push({
          batchId: item.batch_id,
          batchNo: item.batch_no,
          productName: item.product_name,
          receivedQuantity: receivedQty,
          currentQuantity: currentQty,
          difference: Math.round((receivedQty - currentQty) * 100) / 100
        });
      }
    }

    if (offendingMovements.length > 0 || offendingPayments.length > 0 || depletedBatches.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'PURCHASE_VOID_BLOCKED',
        message: 'Cannot void purchase: batches have subsequent movements/depletion or supplier payments reference this purchase',
        batches: offendingMovements.length > 0 ? offendingMovements : depletedBatches,
        payments: offendingPayments
      });
    }

    // 5. Reverse stock movements for each batch and deactivate batch
    for (const item of itemsRes.rows) {
      const qtyToReverse = Number(item.received_quantity);

      // Insert reversing stock movement (type 'void' with negative qty_change)
      await client.query(
        `INSERT INTO stock_movements (
           batch_id, movement_type, qty_change, ref_type, ref_id, created_by
         ) VALUES ($1, 'void', $2, 'purchase_void', $3, $4)`,
        [item.batch_id, -qtyToReverse, purchase.id, userId]
      );

      // Deactivate batch
      await client.query(
        `UPDATE batches SET is_active = false, updated_at = NOW() WHERE id = $1`,
        [item.batch_id]
      );
    }

    // 6. Reversing supplier ledger entry (reduces payable via purchase_void)
    const prevBalance = Number(supplier.outstanding_balance);
    const purchaseTotal = Number(purchase.total_amount);
    const newBalance = Math.round((prevBalance - purchaseTotal) * 100) / 100;

    await client.query(
      `INSERT INTO supplier_ledger (
         supplier_id, entry_type, amount, balance_after, ref_type, ref_id, created_by
       ) VALUES ($1, 'purchase_void', $2, $3, 'purchase_void', $4, $5)`,
      [supplier.id, -purchaseTotal, newBalance, purchase.id, userId]
    );

    // 7. Update purchase record status to 'voided'
    await client.query(
      `UPDATE purchases
       SET status = 'voided',
           void_reason = $1,
           voided_by = $2,
           voided_at = NOW(),
           updated_at = NOW()
       WHERE id = $3`,
      [reason, userId, purchase.id]
    );

    // 8. Write audit log in the same transaction
    await logAuditWithClient(client, {
      userId,
      action: 'PURCHASE_VOIDED',
      entity: 'PURCHASE',
      entityId: purchase.id,
      beforeState: {
        status: 'received',
        totalAmount: purchaseTotal,
        supplierBalanceBefore: prevBalance
      },
      afterState: {
        status: 'voided',
        reason,
        supplierBalanceAfter: newBalance,
        voidedBatches: itemsRes.rows.map((i) => i.batch_id)
      },
      ipAddress
    });

    await client.query('COMMIT');

    return res.json({
      message: 'Purchase successfully voided and reversed',
      purchase: {
        id: purchase.id,
        invoiceNo: purchase.invoice_no,
        status: 'voided',
        voidReason: reason,
        supplierId: supplier.id,
        supplierName: supplier.name,
        previousSupplierBalance: prevBalance,
        newSupplierBalance: newBalance
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Void purchase error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to void purchase' });
  } finally {
    client.release();
  }
});

export { router as purchaseRouter };
