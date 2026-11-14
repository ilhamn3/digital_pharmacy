import { Router, Response } from 'express';
import { z } from 'zod';
import { PoolClient } from 'pg';
import Decimal from 'decimal.js';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { authenticate } from '../middleware/auth.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { logAudit, logAuditWithClient } from '../services/audit.service.js';
import { getColomboDateStr, getColomboDateFormatted, getColomboTimestamp } from '../utils/date.js';

export const saleRouter = Router();

// Apply authentication to all sale routes
saleRouter.use(authenticate);

function getClientIp(req: AuthenticatedRequest): string {
  return (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Computes deterministic canonical SHA-256 hash of a sale checkout payload
 */
export function computeSalePayloadHash(payload: any): string {
  const canonical = {
    customerId: payload.customerId || null,
    items: (payload.items || []).map((i: any) => ({
      productId: i.productId,
      quantity: new Decimal(i.quantity).toFixed(2),
      discountAmount: new Decimal(i.discountAmount || 0).toFixed(2)
    })).sort((a: any, b: any) => a.productId.localeCompare(b.productId)),
    billDiscount: new Decimal(payload.billDiscount || 0).toFixed(2),
    payments: (payload.payments || []).map((p: any) => ({
      type: p.type,
      amount: new Decimal(p.amount).toFixed(2),
      referenceNo: p.referenceNo || null
    })).sort((a: any, b: any) => a.type.localeCompare(b.type)),
    tenderedAmount: new Decimal(payload.tenderedAmount || 0).toFixed(2),
    doctorName: payload.doctorName ? payload.doctorName.trim() : null,
    patientName: payload.patientName ? payload.patientName.trim() : null
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ============================================================================
// Input Validation Schemas
// ============================================================================

const checkoutItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().positive('Quantity must be strictly greater than zero'),
  discountAmount: z.number().min(0, 'Discount amount cannot be negative').default(0)
});

const checkoutPaymentSchema = z.object({
  type: z.enum(['cash', 'card', 'bank_transfer', 'cheque']),
  amount: z.number().positive('Payment amount must be greater than zero'),
  referenceNo: z.string().max(100).optional().nullable()
});

const checkoutSchema = z.object({
  idempotencyKey: z.string({ required_error: 'Idempotency key is required' }).uuid('Invalid idempotency key format'),
  customerId: z.string().uuid().optional().nullable(),
  items: z.array(checkoutItemSchema).min(1, 'Sale must contain at least one item'),
  billDiscount: z.number().min(0, 'Bill discount cannot be negative').default(0),
  payments: z.array(checkoutPaymentSchema).default([]),
  tenderedAmount: z.number().min(0, 'Tendered amount cannot be negative'),
  doctorName: z.string().max(100).optional().nullable(),
  patientName: z.string().max(100).optional().nullable(),
  notes: z.string().optional().nullable()
});

const voidSaleSchema = z.object({
  reason: z.string().min(3, 'Void reason must be at least 3 characters')
});

// ============================================================================
// Helper: Format Sale DTO with Strict Cashier Masking
// ============================================================================

interface SaleRow {
  id: string;
  bill_no: string;
  customer_id: string | null;
  customer_name?: string | null;
  customer_phone?: string | null;
  has_rx_items: boolean;
  subtotal: string;
  discount_amount: string;
  discount_percent: string;
  tax_amount: string;
  total_amount: string;
  paid_amount: string;
  tendered_amount: string;
  change_amount: string;
  balance_due: string;
  payment_status: string;
  status: string;
  doctor_name: string | null;
  patient_name: string | null;
  notes: string | null;
  cashier_id: string;
  cashier_username?: string;
  void_reason?: string | null;
  voided_by?: string | null;
  voided_at?: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  idempotency_key: string;
  idempotency_hash?: string | null;
}

interface SaleItemRow {
  id: string;
  sale_id: string;
  product_id: string;
  product_name: string;
  generic_name?: string;
  batch_id: string;
  batch_no: string;
  expiry_date: string | Date;
  quantity: string;
  unit_cost_price?: string;
  unit_selling_price: string;
  discount_amount: string;
  line_total: string;
}

interface PaymentRow {
  id: string;
  payment_type: string;
  amount: string;
  reference_no: string | null;
  created_at: string | Date;
}

function formatSaleDto(
  sale: SaleRow,
  items: SaleItemRow[],
  payments: PaymentRow[],
  userRole: string
) {
  const isCashier = userRole === 'cashier';

  const formattedItems = items.map((item) => {
    const baseItem: any = {
      id: item.id,
      productId: item.product_id,
      productName: item.product_name,
      genericName: item.generic_name || null,
      batchId: item.batch_id,
      batchNo: item.batch_no,
      expiryDate: typeof item.expiry_date === 'string' ? item.expiry_date : new Date(item.expiry_date).toISOString().split('T')[0],
      quantity: new Decimal(item.quantity).toNumber(),
      unitSellingPrice: new Decimal(item.unit_selling_price).toNumber(),
      discountAmount: new Decimal(item.discount_amount).toNumber(),
      lineTotal: new Decimal(item.line_total).toNumber()
    };

    // Strict cashier data isolation: Never expose cost prices to cashiers
    if (!isCashier && item.unit_cost_price !== undefined) {
      baseItem.unitCostPrice = new Decimal(item.unit_cost_price).toNumber();
    }

    return baseItem;
  });

  const formattedPayments = payments.map((p) => ({
    id: p.id,
    type: p.payment_type,
    amount: new Decimal(p.amount).toNumber(),
    referenceNo: p.reference_no,
    createdAt: typeof p.created_at === 'string' ? p.created_at : new Date(p.created_at).toISOString()
  }));

  const totalItemDiscount = formattedItems.reduce(
    (sum: Decimal, i: any) => sum.plus(new Decimal(i.discountAmount)),
    new Decimal(0)
  );
  const totalDiscount = new Decimal(sale.discount_amount).plus(totalItemDiscount);
  const grossSubtotal = new Decimal(sale.subtotal).plus(totalItemDiscount);
  const discountPercent = grossSubtotal.gt(0)
    ? totalDiscount.times(100).dividedBy(grossSubtotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()
    : 0;

  const dto: any = {
    id: sale.id,
    billNo: sale.bill_no,
    idempotencyKey: sale.idempotency_key,
    idempotencyHash: sale.idempotency_hash || null,
    customerId: sale.customer_id,
    customerName: sale.customer_name || null,
    customerPhone: sale.customer_phone || null,
    hasRxItems: sale.has_rx_items,
    subtotal: grossSubtotal.toNumber(),
    discountAmount: totalDiscount.toNumber(),
    discountPercent,
    taxAmount: new Decimal(sale.tax_amount).toNumber(),
    totalAmount: new Decimal(sale.total_amount).toNumber(),
    paidAmount: new Decimal(sale.paid_amount).toNumber(),
    tenderedAmount: new Decimal(sale.tendered_amount).toNumber(),
    changeAmount: new Decimal(sale.change_amount).toNumber(),
    balanceDue: new Decimal(sale.balance_due).toNumber(),
    paymentStatus: sale.payment_status,
    status: sale.status,
    doctorName: sale.doctor_name,
    patientName: sale.patient_name,
    notes: sale.notes,
    cashierId: sale.cashier_id,
    cashierUsername: sale.cashier_username || null,
    createdAt: typeof sale.created_at === 'string' ? sale.created_at : new Date(sale.created_at).toISOString(),
    updatedAt: typeof sale.updated_at === 'string' ? sale.updated_at : new Date(sale.updated_at).toISOString(),
    items: formattedItems,
    payments: formattedPayments
  };

  if (sale.status === 'voided') {
    dto.voidReason = sale.void_reason;
    dto.voidedBy = sale.voided_by;
    dto.voidedAt = sale.voided_at ? (typeof sale.voided_at === 'string' ? sale.voided_at : new Date(sale.voided_at).toISOString()) : null;
  }

  return dto;
}

/**
 * Fetch full sale by ID or idempotency key and return formatted DTO
 */
async function fetchSaleDto(
  clientOrPool: PoolClient | typeof pool,
  lookup: { id?: string; idempotencyKey?: string; cashierId?: string },
  userRole: string
) {
  let saleQuery = `
    SELECT 
      s.*,
      c.name as customer_name,
      c.phone as customer_phone,
      u.username as cashier_username
    FROM sales s
    LEFT JOIN customers c ON s.customer_id = c.id
    LEFT JOIN users u ON s.cashier_id = u.id
    WHERE `;

  const params: any[] = [];
  if (lookup.id) {
    saleQuery += `s.id = $1`;
    params.push(lookup.id);
  } else if (lookup.idempotencyKey && lookup.cashierId) {
    saleQuery += `s.cashier_id = $1 AND s.idempotency_key = $2`;
    params.push(lookup.cashierId, lookup.idempotencyKey);
  } else {
    saleQuery += `s.idempotency_key = $1`;
    params.push(lookup.idempotencyKey);
  }

  const saleRes = await clientOrPool.query(saleQuery, params);
  if (saleRes.rows.length === 0) return null;
  const sale = saleRes.rows[0];

  const itemsRes = await clientOrPool.query(
    `SELECT 
       si.*,
       p.name as product_name,
       p.generic_name,
       b.batch_no,
       b.expiry_date
     FROM sale_items si
     JOIN products p ON si.product_id = p.id
     JOIN batches b ON si.batch_id = b.id
     WHERE si.sale_id = $1
     ORDER BY si.created_at ASC, si.id ASC`,
    [sale.id]
  );

  const paymentsRes = await clientOrPool.query(
    `SELECT id, payment_type, amount, reference_no, created_at
     FROM payments
     WHERE sale_id = $1
     ORDER BY created_at ASC`,
    [sale.id]
  );

  return formatSaleDto(sale, itemsRes.rows, paymentsRes.rows, userRole);
}

// ============================================================================
// POST /api/v1/sales: Sales Checkout Engine
// ============================================================================

saleRouter.post('/', async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const userId = req.user!.id;
  const userRole = req.user!.role;

  const parseResult = checkoutSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const {
    idempotencyKey,
    customerId,
    items,
    billDiscount,
    payments,
    tenderedAmount,
    doctorName,
    patientName,
    notes
  } = parseResult.data;

  // Compute canonical SHA-256 hash of payload
  const payloadHash = computeSalePayloadHash(req.body);

  // 1. Fast idempotency check before opening transaction (per-user scope)
  const existingSale = await fetchSaleDto(pool, { idempotencyKey, cashierId: userId }, userRole);
  if (existingSale) {
    if (existingSale.idempotencyHash && existingSale.idempotencyHash !== payloadHash) {
      return res.status(409).json({
        error: 'IDEMPOTENCY_CONFLICT',
        message: 'Idempotency key has already been used with a different request payload.'
      });
    }
    return res.status(200).json({
      message: 'Sale already processed (idempotent response)',
      sale: existingSale
    });
  }

  // 2. Retry loop for deadlocks (40P01) or serialization failures (40001)
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Re-check idempotency inside transaction
      const inTxExisting = await fetchSaleDto(client, { idempotencyKey, cashierId: userId }, userRole);
      if (inTxExisting) {
        if (inTxExisting.idempotencyHash && inTxExisting.idempotencyHash !== payloadHash) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: 'IDEMPOTENCY_CONFLICT',
            message: 'Idempotency key has already been used with a different request payload.'
          });
        }
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'Sale already processed (idempotent response)',
          sale: inTxExisting
        });
      }

      // Load settings
      const settingsRes = await client.query(
        `SELECT key, value FROM settings WHERE key IN ('tax_rate', 'role_discount_limits', 'rx_settings', 'inventory_settings')`
      );
      const settingsMap = new Map<string, any>();
      for (const row of settingsRes.rows) {
        settingsMap.set(row.key, row.value);
      }

      const taxSettings = settingsMap.get('tax_rate') || { rate: 0.00 };
      const roleLimits = settingsMap.get('role_discount_limits') || { cashier: 5.00, pharmacist: 15.00, owner: 100.00 };
      const rxSettings = settingsMap.get('rx_settings') || { rx_requires_pharmacist: true };
      const invSettings = settingsMap.get('inventory_settings') || { min_sellable_shelf_life_days: 0 };

      const minShelfLife = Math.max(0, invSettings.min_sellable_shelf_life_days || 0);

      // Deterministic product sorting by UUID to eliminate cross-transaction deadlocks
      const uniqueProductIds = Array.from(new Set(items.map((i) => i.productId))).sort();

      // Lock products with FOR SHARE
      const prodRes = await client.query(
        `SELECT id, name, is_rx_required, allow_fractional_qty, is_active
         FROM products
         WHERE id = ANY($1)
         FOR SHARE`,
        [uniqueProductIds]
      );

      const productMap = new Map<string, any>();
      for (const p of prodRes.rows) {
        productMap.set(p.id, p);
      }

      let hasRxItems = false;

      // Validate products exist, are active, and enforce fractional quantity rule
      for (const item of items) {
        const prod = productMap.get(item.productId);
        if (!prod) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'PRODUCT_NOT_FOUND',
            message: `Product with ID '${item.productId}' does not exist.`
          });
        }

        if (!prod.is_active) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'PRODUCT_INACTIVE',
            message: `Product '${prod.name}' is deactivated and cannot be sold.`
          });
        }

        if (!prod.allow_fractional_qty && !Number.isInteger(item.quantity)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'FRACTIONAL_QUANTITY_NOT_ALLOWED',
            message: `Product '${prod.name}' does not allow fractional quantities. Integer quantity required.`
          });
        }

        if (prod.is_rx_required) {
          hasRxItems = true;
        }
      }

      // Rx security validation
      if (hasRxItems) {
        if (!doctorName || doctorName.trim() === '' || !patientName || patientName.trim() === '') {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'RX_DETAILS_REQUIRED',
            message: 'Prescription items require valid doctorName and patientName.'
          });
        }

        // rx_requires_pharmacist toggle enforcement
        const rxRequiresPharmacist = rxSettings.rx_requires_pharmacist !== false;
        if (rxRequiresPharmacist && userRole === 'cashier') {
          await client.query('ROLLBACK');
          return res.status(403).json({
            error: 'RX_DISPENSING_RESTRICTED',
            message: 'Cashiers are not permitted to dispense prescription-only medications. Pharmacist or owner approval required.'
          });
        }
      }

      // FEFO Allocation per product using Decimal
      interface SliceAllocation {
        productId: string;
        productName: string;
        batchId: string;
        batchNo: string;
        expiryDate: string;
        unitCostPrice: string;
        unitSellingPrice: string;
        quantity: Decimal;
        discountAmount: Decimal;
        lineTotal: Decimal;
      }

      const allocatedSlices: SliceAllocation[] = [];
      let calculatedGrossSubtotal = new Decimal(0);
      let totalItemDiscounts = new Decimal(0);

      for (const productId of uniqueProductIds) {
        const prod = productMap.get(productId);
        const productItems = items.filter((i) => i.productId === productId);
        const totalRequestedQty = productItems.reduce(
          (sum, i) => sum.plus(new Decimal(i.quantity)),
          new Decimal(0)
        );
        const totalRequestedItemDiscount = productItems.reduce(
          (sum, i) => sum.plus(new Decimal(i.discountAmount)),
          new Decimal(0)
        );

        // Lock batches FOR UPDATE in FEFO order (expiry_date ASC, id ASC)
        // Uses make_interval(days => $2::int)
        const batchRes = await client.query(
          `SELECT id, batch_no, expiry_date::text, cost_price::text, mrp::text, current_quantity::text
           FROM batches
           WHERE product_id = $1 
             AND is_active = true 
             AND current_quantity > 0
             AND expiry_date >= CURRENT_DATE + make_interval(days => $2::int)
           ORDER BY expiry_date ASC, id ASC
           FOR UPDATE`,
          [productId, minShelfLife]
        );

        let availableQty = new Decimal(0);
        for (const b of batchRes.rows) {
          availableQty = availableQty.plus(new Decimal(b.current_quantity));
        }

        if (availableQty.lt(totalRequestedQty)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'INSUFFICIENT_STOCK',
            message: `Insufficient sellable stock for '${prod.name}'. Requested ${totalRequestedQty.toFixed(2)}, but only ${availableQty.toFixed(2)} available across active non-expired batches.`,
            productId,
            productName: prod.name,
            requestedQuantity: totalRequestedQty.toNumber(),
            availableQuantity: availableQty.toNumber()
          });
        }

        // Allocate FEFO
        let remainingToAllocate = new Decimal(totalRequestedQty);
        for (const batch of batchRes.rows) {
          if (remainingToAllocate.lte(0)) break;

          const batchStock = new Decimal(batch.current_quantity);
          const sliceQty = Decimal.min(remainingToAllocate, batchStock);
          const unitSellingPrice = new Decimal(batch.mrp);
          const unitCostPrice = new Decimal(batch.cost_price);

          // Proportional item discount allocation
          const sliceDiscount = totalRequestedQty.gt(0)
            ? totalRequestedItemDiscount.times(sliceQty.dividedBy(totalRequestedQty)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
            : new Decimal(0);

          const sliceGross = sliceQty.times(unitSellingPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
          const sliceTotal = sliceGross.minus(sliceDiscount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

          allocatedSlices.push({
            productId,
            productName: prod.name,
            batchId: batch.id,
            batchNo: batch.batch_no,
            expiryDate: batch.expiry_date,
            unitCostPrice: batch.cost_price,
            unitSellingPrice: batch.mrp,
            quantity: sliceQty,
            discountAmount: sliceDiscount,
            lineTotal: sliceTotal
          });

          calculatedGrossSubtotal = calculatedGrossSubtotal.plus(sliceGross);
          totalItemDiscounts = totalItemDiscounts.plus(sliceDiscount);
          remainingToAllocate = remainingToAllocate.minus(sliceQty);
        }
      }

      // Combined Discount Limit Check (Item discounts + Bill discount)
      const billDiscountDec = new Decimal(billDiscount);
      const totalDiscount = totalItemDiscounts.plus(billDiscountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      const discountPercent = calculatedGrossSubtotal.gt(0)
        ? totalDiscount.times(100).dividedBy(calculatedGrossSubtotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : new Decimal(0);

      const allowedRoleLimit = new Decimal(typeof roleLimits[userRole] === 'number' ? roleLimits[userRole] : 0.00);
      if (discountPercent.gt(allowedRoleLimit)) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'DISCOUNT_LIMIT_EXCEEDED',
          message: `Combined discount of ${discountPercent.toFixed(2)}% exceeds the maximum allowed limit of ${allowedRoleLimit.toFixed(2)}% for role '${userRole}'. Owner override required.`,
          requestedDiscountPercent: discountPercent.toNumber(),
          allowedLimit: allowedRoleLimit.toNumber()
        });
      }

      // Line totals sum (net of item discounts, matches sales.subtotal in DB)
      const lineTotalsSum = allocatedSlices.reduce(
        (sum, s) => sum.plus(s.lineTotal),
        new Decimal(0)
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      // Tax calculations
      const taxRateDec = new Decimal(typeof taxSettings.rate === 'number' ? taxSettings.rate : 0.00);
      const taxableBase = Decimal.max(0, lineTotalsSum.minus(billDiscountDec));
      const taxAmount = taxableBase.times(taxRateDec.dividedBy(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const grandTotal = lineTotalsSum.minus(billDiscountDec).plus(taxAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      // Payment and change reconciliation using Decimal
      const totalPaidApplied = payments.reduce(
        (sum, p) => sum.plus(new Decimal(p.amount)),
        new Decimal(0)
      ).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      if (totalPaidApplied.gt(grandTotal)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'PAYMENT_EXCEEDS_TOTAL',
          message: `Paid amount applied to the bill (Rs. ${totalPaidApplied.toFixed(2)}) cannot exceed total bill amount (Rs. ${grandTotal.toFixed(2)}). Tendered amount should absorb extra cash.`
        });
      }

      const tenderedDec = new Decimal(tenderedAmount);
      if (tenderedDec.lt(totalPaidApplied)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'TENDERED_LESS_THAN_PAID',
          message: `Tendered amount (Rs. ${tenderedDec.toFixed(2)}) must be greater than or equal to paid amount applied to the bill (Rs. ${totalPaidApplied.toFixed(2)}).`
        });
      }

      // Card Over-Tender Enforcement:
      // Non-cash payments cannot be over-tendered
      const hasNonCashPayment = payments.some((p) => p.type !== 'cash');
      const hasCashPayment = payments.some((p) => p.type === 'cash');
      if (hasNonCashPayment && !hasCashPayment && tenderedDec.gt(totalPaidApplied)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'CARD_OVER_TENDER_REJECTED',
          message: 'Over-tendering is not permitted for card or non-cash payments. Tendered amount must equal paid amount.'
        });
      }

      const changeAmount = tenderedDec.minus(totalPaidApplied).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const balanceDue = grandTotal.minus(totalPaidApplied).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

      let paymentStatus = 'paid';
      if (balanceDue.gt(0)) {
        paymentStatus = totalPaidApplied.gt(0) ? 'partial' : 'credit';
      }

      // Credit Customer Validation & Ledger
      let customerName: string | null = null;
      let customerPhone: string | null = null;

      if (balanceDue.gt(0)) {
        if (!customerId) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'CUSTOMER_REQUIRED_FOR_CREDIT',
            message: 'A registered customer is required for credit or partial sales with an outstanding balance. Walk-in credit sales are prohibited.'
          });
        }

        const custRes = await client.query(
          `SELECT id, name, phone, credit_limit::text, credit_balance::text, is_active
           FROM customers
           WHERE id = $1
           FOR UPDATE`,
          [customerId]
        );

        if (custRes.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'CUSTOMER_NOT_FOUND',
            message: 'Specified customer does not exist.'
          });
        }

        const customer = custRes.rows[0];
        if (!customer.is_active) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'CUSTOMER_INACTIVE',
            message: `Customer '${customer.name}' is deactivated and cannot receive credit.`
          });
        }

        customerName = customer.name;
        customerPhone = customer.phone;

        const currentCreditBal = new Decimal(customer.credit_balance);
        const creditLimit = new Decimal(customer.credit_limit);
        const newCreditBal = currentCreditBal.plus(balanceDue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        if (newCreditBal.gt(creditLimit)) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'CREDIT_LIMIT_EXCEEDED',
            message: `Customer credit limit exceeded. Current balance: Rs. ${currentCreditBal.toFixed(2)}, sale credit: Rs. ${balanceDue.toFixed(2)}, new balance: Rs. ${newCreditBal.toFixed(2)}, credit limit: Rs. ${creditLimit.toFixed(2)}.`,
            currentBalance: currentCreditBal.toNumber(),
            requestedCredit: balanceDue.toNumber(),
            creditLimit: creditLimit.toNumber()
          });
        }
      } else if (customerId) {
        const custRes = await client.query(`SELECT name, phone FROM customers WHERE id = $1`, [customerId]);
        if (custRes.rows.length > 0) {
          customerName = custRes.rows[0].name;
          customerPhone = custRes.rows[0].phone;
        }
      }

      // 3. Generate Gap-Free Bill Number with INV-YYYYMMDD-#### format (LAST before inserting sale)
      const dateStr = getColomboDateStr();
      const seqKey = `INV-${dateStr}`;

      const seqRes = await client.query(
        `INSERT INTO bill_sequences (sequence_key, current_number)
         VALUES ($1, 1)
         ON CONFLICT (sequence_key)
         DO UPDATE SET current_number = bill_sequences.current_number + 1, updated_at = NOW()
         RETURNING current_number`,
        [seqKey]
      );
      const seqNumber = seqRes.rows[0].current_number;
      const billNo = `${seqKey}-${String(seqNumber).padStart(4, '0')}`;

      // 4. Insert Sales Record with payload hash and exact Decimal strings
      const saleRes = await client.query(
        `INSERT INTO sales (
           idempotency_key, idempotency_hash, bill_no, customer_id, has_rx_items,
           subtotal, discount_amount, discount_percent, tax_amount,
           total_amount, paid_amount, tendered_amount, change_amount,
           balance_due, payment_status, status, doctor_name, patient_name,
           notes, cashier_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
           $15, 'completed', $16, $17, $18, $19
         ) RETURNING *`,
        [
          idempotencyKey,
          payloadHash,
          billNo,
          customerId || null,
          hasRxItems,
          lineTotalsSum.toFixed(2),
          billDiscountDec.toFixed(2),
          discountPercent.toFixed(2),
          taxAmount.toFixed(2),
          grandTotal.toFixed(2),
          totalPaidApplied.toFixed(2),
          tenderedDec.toFixed(2),
          changeAmount.toFixed(2),
          balanceDue.toFixed(2),
          paymentStatus,
          doctorName || null,
          patientName || null,
          notes || null,
          userId
        ]
      );
      const sale = saleRes.rows[0];

      // 5. Insert Stock Movements for each allocated batch directly referencing sale.id
      for (const slice of allocatedSlices) {
        await client.query(
          `INSERT INTO stock_movements (
             batch_id, movement_type, qty_change, ref_type, ref_id, created_by
           ) VALUES ($1, 'sale', $2, 'sale', $3, $4)`,
          [slice.batchId, -slice.quantity.toNumber(), sale.id, userId]
        );
      }

      // 6. Insert Sale Items
      const createdItems: SaleItemRow[] = [];
      for (const slice of allocatedSlices) {
        const itemRes = await client.query(
          `INSERT INTO sale_items (
             sale_id, product_id, batch_id, quantity,
             unit_cost_price, unit_selling_price, discount_amount, line_total
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            sale.id,
            slice.productId,
            slice.batchId,
            slice.quantity.toFixed(2),
            slice.unitCostPrice,
            slice.unitSellingPrice,
            slice.discountAmount.toFixed(2),
            slice.lineTotal.toFixed(2)
          ]
        );
        createdItems.push({
          ...itemRes.rows[0],
          product_name: slice.productName,
          batch_no: slice.batchNo,
          expiry_date: slice.expiryDate
        });
      }

      // 7. Insert Payments
      const createdPayments: PaymentRow[] = [];
      for (const p of payments) {
        const payRes = await client.query(
          `INSERT INTO payments (
             sale_id, payment_type, amount, reference_no
           ) VALUES ($1, $2, $3, $4)
           RETURNING id, payment_type, amount, reference_no, created_at`,
          [sale.id, p.type, new Decimal(p.amount).toFixed(2), p.referenceNo || null]
        );
        createdPayments.push(payRes.rows[0]);
      }

      // 8. If credit sale, update customer_ledger (trigger updates customer balance)
      if (balanceDue.gt(0) && customerId) {
        const custBalanceRes = await client.query(
          `SELECT credit_balance::text FROM customers WHERE id = $1`,
          [customerId]
        );
        const prevBal = new Decimal(custBalanceRes.rows[0].credit_balance);
        const newBal = prevBal.plus(balanceDue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        await client.query(
          `INSERT INTO customer_ledger (
             customer_id, entry_type, amount, balance_after, ref_type, ref_id, created_by
           ) VALUES ($1, 'credit_sale', $2, $3, 'sale', $4, $5)`,
          [customerId, balanceDue.toFixed(2), newBal.toFixed(2), sale.id, userId]
        );
      }

      // 9. Write audit log in the same transaction using client
      await logAuditWithClient(client, {
        userId,
        action: 'SALE_CREATED',
        entity: 'SALE',
        entityId: sale.id,
        afterState: {
          billNo,
          idempotencyKey,
          idempotencyHash: payloadHash,
          totalAmount: grandTotal.toFixed(2),
          paidAmount: totalPaidApplied.toFixed(2),
          tenderedAmount: tenderedDec.toFixed(2),
          changeAmount: changeAmount.toFixed(2),
          balanceDue: balanceDue.toFixed(2),
          paymentStatus,
          itemCount: createdItems.length
        },
        ipAddress
      });

      // Commit transaction
      await client.query('COMMIT');

      // Format response DTO
      const responseDto = formatSaleDto(
        {
          ...sale,
          customer_name: customerName,
          customer_phone: customerPhone,
          cashier_username: req.user!.username
        },
        createdItems,
        createdPayments,
        userRole
      );

      return res.status(201).json({
        message: 'Sale completed successfully',
        sale: responseDto
      });
    } catch (error: any) {
      await client.query('ROLLBACK');

      // If concurrency collision on idempotency key, query and return existing sale
      if (error.code === '23505' && (error.constraint === 'uq_sales_user_idempotency_key' || error.constraint === 'uq_sales_idempotency_key')) {
        const existing = await fetchSaleDto(pool, { idempotencyKey, cashierId: userId }, userRole);
        if (existing) {
          if (existing.idempotencyHash && existing.idempotencyHash !== payloadHash) {
            return res.status(409).json({
              error: 'IDEMPOTENCY_CONFLICT',
              message: 'Idempotency key has already been used with a different request payload.'
            });
          }
          return res.status(200).json({
            message: 'Sale already processed (idempotent response)',
            sale: existing
          });
        }
      }

      // If deadlock or serialization failure, retry
      if ((error.code === '40P01' || error.code === '40001') && attempt < maxRetries) {
        console.warn(`[RETRY] Transaction deadlock/serialization conflict (${error.code}) on attempt ${attempt}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
        continue;
      }

      console.error('Checkout transaction error:', error);
      return res.status(500).json({
        error: 'INTERNAL_ERROR',
        message: 'Failed to process sale',
        details: error.message
      });
    } finally {
      client.release();
    }
  }

  return res.status(500).json({
    error: 'TRANSACTION_RETRY_EXHAUSTED',
    message: 'Could not complete sale transaction after multiple attempts due to high contention.'
  });
});

// ============================================================================
// GET /api/v1/sales: List Sales with Role-Based Scoping
// ============================================================================

saleRouter.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

    const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 100);
    const offset = parseInt(String(req.query.offset || '0'), 10);
    const status = req.query.status ? String(req.query.status) : null;
    const customerId = req.query.customerId ? String(req.query.customerId) : null;
    const startDate = req.query.startDate ? String(req.query.startDate) : null;
    const endDate = req.query.endDate ? String(req.query.endDate) : null;

    const whereClauses: string[] = [];
    const values: any[] = [];
    let idx = 1;

    // Cashier role restriction: ONLY own sales, and ONLY today's sales
    if (userRole === 'cashier') {
      whereClauses.push(`s.cashier_id = $${idx++}`);
      values.push(userId);
      whereClauses.push(`s.created_at >= CURRENT_DATE`);
    } else {
      // Owner/pharmacist can filter by cashier
      if (req.query.cashierId) {
        whereClauses.push(`s.cashier_id = $${idx++}`);
        values.push(String(req.query.cashierId));
      }
      if (startDate) {
        whereClauses.push(`s.created_at >= $${idx++}`);
        values.push(startDate);
      }
      if (endDate) {
        whereClauses.push(`s.created_at <= $${idx++}`);
        values.push(endDate);
      }
    }

    if (status) {
      whereClauses.push(`s.status = $${idx++}`);
      values.push(status);
    }

    if (customerId) {
      whereClauses.push(`s.customer_id = $${idx++}`);
      values.push(customerId);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countQuery = `SELECT COUNT(*) FROM sales s ${whereStr}`;
    const countRes = await pool.query(countQuery, values);
    const totalCount = parseInt(countRes.rows[0].count, 10);

    const listQuery = `
      SELECT 
        s.id, s.bill_no, s.customer_id, s.has_rx_items,
        s.subtotal::text, s.discount_amount::text, s.discount_percent::text, s.tax_amount::text,
        s.total_amount::text, s.paid_amount::text, s.tendered_amount::text, s.change_amount::text,
        s.balance_due::text, s.payment_status, s.status, s.doctor_name, s.patient_name,
        s.notes, s.cashier_id, s.created_at, s.updated_at, s.idempotency_key, s.idempotency_hash,
        c.name as customer_name,
        c.phone as customer_phone,
        u.username as cashier_username
      FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.id
      LEFT JOIN users u ON s.cashier_id = u.id
      ${whereStr}
      ORDER BY s.created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    values.push(limit, offset);
    const listRes = await pool.query(listQuery, values);

    const formattedSales = listRes.rows.map((r) => ({
      id: r.id,
      billNo: r.bill_no,
      idempotencyKey: r.idempotency_key,
      idempotencyHash: r.idempotency_hash || null,
      customerId: r.customer_id,
      customerName: r.customer_name || null,
      customerPhone: r.customer_phone || null,
      hasRxItems: r.has_rx_items,
      subtotal: new Decimal(r.subtotal).toNumber(),
      discountAmount: new Decimal(r.discount_amount).toNumber(),
      discountPercent: new Decimal(r.discount_percent || 0).toNumber(),
      taxAmount: new Decimal(r.tax_amount).toNumber(),
      totalAmount: new Decimal(r.total_amount).toNumber(),
      paidAmount: new Decimal(r.paid_amount).toNumber(),
      tenderedAmount: new Decimal(r.tendered_amount).toNumber(),
      changeAmount: new Decimal(r.change_amount).toNumber(),
      balanceDue: new Decimal(r.balance_due).toNumber(),
      paymentStatus: r.payment_status,
      status: r.status,
      doctorName: r.doctor_name,
      patientName: r.patient_name,
      notes: r.notes,
      cashierId: r.cashier_id,
      cashierUsername: r.cashier_username,
      createdAt: typeof r.created_at === 'string' ? r.created_at : new Date(r.created_at).toISOString(),
      updatedAt: typeof r.updated_at === 'string' ? r.updated_at : new Date(r.updated_at).toISOString()
    }));

    return res.json({
      sales: formattedSales,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      }
    });
  } catch (error: any) {
    console.error('List sales error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve sales' });
  }
});

// ============================================================================
// GET /api/v1/sales/:id: Sale Details
// ============================================================================

saleRouter.get('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const saleId = String(req.params.id);
    const userRole = req.user!.role;
    const userId = req.user!.id;

    const saleDto = await fetchSaleDto(pool, { id: saleId }, userRole);
    if (!saleDto) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Sale not found' });
    }

    // Cashier scoping enforcement
    if (userRole === 'cashier') {
      const saleDateStr = getColomboDateFormatted(new Date(saleDto.createdAt));
      const todayStr = getColomboDateFormatted(new Date());
      if (saleDto.cashierId !== userId || saleDateStr !== todayStr) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Cashiers can only view their own sales from today.'
        });
      }
    }

    return res.json({ sale: saleDto });
  } catch (error: any) {
    console.error('Get sale error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to retrieve sale' });
  }
});

// ============================================================================
// GET /api/v1/sales/:id/receipt: 80mm Thermal Receipt Generator & Reprint Audit
// ============================================================================

saleRouter.get('/:id/receipt', async (req: AuthenticatedRequest, res: Response) => {
  const saleId = String(req.params.id);
  const userRole = req.user!.role;
  const userId = req.user!.id;
  const ipAddress = getClientIp(req);

  try {
    const saleDto = await fetchSaleDto(pool, { id: saleId }, userRole);
    if (!saleDto) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Sale not found' });
    }

    // Cashier scoping check
    if (userRole === 'cashier') {
      const saleDateStr = getColomboDateFormatted(new Date(saleDto.createdAt));
      const todayStr = getColomboDateFormatted(new Date());
      if (saleDto.cashierId !== userId || saleDateStr !== todayStr) {
        return res.status(403).json({
          error: 'FORBIDDEN',
          message: 'Cashiers can only access receipts for their own sales from today.'
        });
      }
    }

    // Check if receipt was previously generated/printed
    const auditRes = await pool.query(
      `SELECT id, action, created_at
       FROM audit_logs
       WHERE entity = 'SALE' AND entity_id = $1 AND action IN ('RECEIPT_PRINTED', 'RECEIPT_REPRINTED')
       ORDER BY created_at ASC`,
      [saleId]
    );

    const isDuplicate = auditRes.rows.length > 0;

    // Log receipt print/reprint audit entry
    await logAudit({
      userId,
      action: isDuplicate ? 'RECEIPT_REPRINTED' : 'RECEIPT_PRINTED',
      entity: 'SALE',
      entityId: saleId,
      afterState: {
        billNo: saleDto.billNo,
        reprintCount: auditRes.rows.length,
        isDuplicate
      },
      ipAddress
    });

    // Generate 80mm ESC/POS formatted receipt text (42 chars width standard)
    const lineDivider = '------------------------------------------';
    const doubleDivider = '==========================================';

    function padCenter(str: string, width: number = 42): string {
      const pad = Math.max(0, Math.floor((width - str.length) / 2));
      return ' '.repeat(pad) + str;
    }

    function row2(left: string, right: string, width: number = 42): string {
      const space = Math.max(1, width - left.length - right.length);
      return left + ' '.repeat(space) + right;
    }

    const lines: string[] = [];

    lines.push(doubleDivider);
    if (isDuplicate) {
      lines.push(padCenter('*** DUPLICATE / REPRINT ***'));
      lines.push(doubleDivider);
    }

    lines.push(padCenter('CITY HEALTH PHARMACY'));
    lines.push(padCenter('No. 124, Galle Road, Colombo 03'));
    lines.push(padCenter('Tel: +94 11 257 8900 / +94 77 123 4567'));
    lines.push(padCenter('Reg/VAT: 104582910-7000'));
    lines.push(doubleDivider);

    lines.push(row2('Bill No:', saleDto.billNo));
    lines.push(row2('Date:', getColomboTimestamp(new Date(saleDto.createdAt))));
    lines.push(row2('Cashier:', saleDto.cashierUsername || 'Staff'));
    if (saleDto.customerName) {
      lines.push(row2('Customer:', saleDto.customerName));
    }
    if (saleDto.hasRxItems) {
      lines.push(row2('Doctor:', saleDto.doctorName || 'N/A'));
      lines.push(row2('Patient:', saleDto.patientName || 'N/A'));
    }
    lines.push(lineDivider);
    lines.push('Item Description          Qty   Price     Total');
    lines.push(lineDivider);

    for (const item of saleDto.items) {
      lines.push(item.productName.substring(0, 42));
      const batchPart = `(B:${item.batchNo})`;
      const qtyStr = new Decimal(item.quantity).toFixed(2);
      const priceStr = new Decimal(item.unitSellingPrice).toFixed(2);
      const totalStr = new Decimal(item.lineTotal).toFixed(2);
      lines.push(`  ${batchPart.padEnd(16)} ${qtyStr.padStart(5)} ${priceStr.padStart(8)} ${totalStr.padStart(9)}`);
    }

    lines.push(lineDivider);
    lines.push(row2('Gross Subtotal:', `Rs. ${new Decimal(saleDto.subtotal).toFixed(2)}`));
    if (saleDto.discountAmount > 0) {
      lines.push(row2(`Discount (${new Decimal(saleDto.discountPercent).toFixed(1)}%):`, `-Rs. ${new Decimal(saleDto.discountAmount).toFixed(2)}`));
    }
    if (saleDto.taxAmount > 0) {
      lines.push(row2('VAT / Tax:', `Rs. ${new Decimal(saleDto.taxAmount).toFixed(2)}`));
    }
    lines.push(doubleDivider);
    lines.push(row2('TOTAL AMOUNT:', `Rs. ${new Decimal(saleDto.totalAmount).toFixed(2)}`));
    lines.push(doubleDivider);

    for (const pay of saleDto.payments) {
      lines.push(row2(`Paid (${pay.type.toUpperCase()}):`, `Rs. ${new Decimal(pay.amount).toFixed(2)}`));
    }
    lines.push(row2('Tendered Cash:', `Rs. ${new Decimal(saleDto.tenderedAmount).toFixed(2)}`));
    lines.push(row2('Change Returned:', `Rs. ${new Decimal(saleDto.changeAmount).toFixed(2)}`));

    if (saleDto.balanceDue > 0) {
      lines.push(doubleDivider);
      lines.push(row2('BALANCE DUE (CREDIT):', `Rs. ${new Decimal(saleDto.balanceDue).toFixed(2)}`));
    }

    lines.push(doubleDivider);
    lines.push(padCenter('Thank you for choosing City Health!'));
    lines.push(padCenter('Medicines are non-returnable once taken.'));
    lines.push(padCenter('For queries: info@cityhealthpharmacy.lk'));
    lines.push(doubleDivider);

    const receiptText = lines.join('\n');

    return res.json({
      billNo: saleDto.billNo,
      isDuplicate,
      reprintCount: auditRes.rows.length,
      receiptText,
      receiptData: {
        header: {
          pharmacyName: 'CITY HEALTH PHARMACY',
          address: 'No. 124, Galle Road, Colombo 03',
          phone: '+94 11 257 8900',
          vatReg: '104582910-7000'
        },
        sale: saleDto,
        printedAt: getColomboTimestamp()
      }
    });
  } catch (error: any) {
    console.error('Generate receipt error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to generate receipt' });
  }
});

// ============================================================================
// POST /api/v1/sales/:id/void: Void Sale & Reverse Stock / Ledger
// ============================================================================

saleRouter.post('/:id/void', requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const saleId = String(req.params.id);
  const userRole = req.user!.role;
  const userId = req.user!.id;
  const ipAddress = getClientIp(req);

  const parseResult = voidSaleSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const { reason } = parseResult.data;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Lock sale row FOR UPDATE
    const saleRes = await client.query(
      `SELECT * FROM sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );

    if (saleRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Sale not found' });
    }

    const sale = saleRes.rows[0];

    if (sale.status === 'voided') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ALREADY_VOIDED', message: 'Sale has already been voided.' });
    }

    // 2. Check same-day void restriction using Asia/Colombo date
    const settingsRes = await client.query(
      `SELECT value FROM settings WHERE key = 'sales_settings'`
    );
    const salesSettings = settingsRes.rows[0]?.value || { sale_void_same_day_only: true };

    if (salesSettings.sale_void_same_day_only && userRole !== 'owner') {
      const saleDateColombo = getColomboDateFormatted(new Date(sale.created_at));
      const todayColombo = getColomboDateFormatted(new Date());

      if (saleDateColombo !== todayColombo) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'VOID_SAME_DAY_ONLY',
          message: 'Only pharmacy owners can void sales from previous business days.'
        });
      }
    }

    // 3. Check if sale has existing returns
    const returnCheck = await client.query(
      `SELECT COUNT(*) FROM sales_returns WHERE original_sale_id = $1`,
      [saleId]
    );

    if (parseInt(returnCheck.rows[0].count, 10) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'VOID_BLOCKED_HAS_RETURNS',
        message: 'Cannot void sale: return transactions already exist against this sale.'
      });
    }

    // 4. Reverse stock: insert stock_movements ('void' with positive qty_change)
    const itemsRes = await client.query(
      `SELECT id, product_id, batch_id, quantity::text, unit_selling_price::text
       FROM sale_items
       WHERE sale_id = $1`,
      [saleId]
    );

    for (const item of itemsRes.rows) {
      const qtyToRestore = new Decimal(item.quantity).toNumber();
      // Movement type 'void' with positive qty_change restores stock
      await client.query(
        `INSERT INTO stock_movements (
           batch_id, movement_type, qty_change, ref_type, ref_id, created_by
         ) VALUES ($1, 'void', $2, 'sale_void', $3, $4)`,
        [item.batch_id, qtyToRestore, sale.id, userId]
      );
    }

    // 5. If sale had customer balance due, reverse customer credit ledger
    const balanceDue = new Decimal(sale.balance_due);
    if (balanceDue.gt(0) && sale.customer_id) {
      const custRes = await client.query(
        `SELECT id, credit_balance::text FROM customers WHERE id = $1 FOR UPDATE`,
        [sale.customer_id]
      );

      if (custRes.rows.length > 0) {
        const curBal = new Decimal(custRes.rows[0].credit_balance);
        const newBal = curBal.minus(balanceDue).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        await client.query(
          `INSERT INTO customer_ledger (
             customer_id, entry_type, amount, balance_after, ref_type, ref_id, created_by
           ) VALUES ($1, 'adjustment', $2, $3, 'sale_void', $4, $5)`,
          [sale.customer_id, -balanceDue.toNumber(), newBal.toFixed(2), sale.id, userId]
        );
      }
    }

    // 6. Update sale status to 'voided' with reason, voided_by, voided_at
    // (Protected by trg_protect_sales_update trigger)
    const voidTime = new Date().toISOString();
    await client.query(
      `UPDATE sales
       SET status = 'voided',
           void_reason = $1,
           voided_by = $2,
           voided_at = $3
       WHERE id = $4`,
      [reason, userId, voidTime, saleId]
    );

    // 7. Audit log with transactional client
    await logAuditWithClient(client, {
      userId,
      action: 'SALE_VOIDED',
      entity: 'SALE',
      entityId: sale.id,
      afterState: {
        billNo: sale.bill_no,
        reason,
        voidedBy: userId,
        voidedAt: voidTime,
        restoredItemsCount: itemsRes.rows.length,
        reversedCredit: balanceDue.toFixed(2)
      },
      ipAddress
    });

    await client.query('COMMIT');

    const updatedSaleDto = await fetchSaleDto(pool, { id: saleId }, userRole);

    return res.status(200).json({
      message: 'Sale voided successfully and stock restored',
      sale: updatedSaleDto
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    console.error('Void sale error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to void sale',
      details: error.message
    });
  } finally {
    client.release();
  }
});
