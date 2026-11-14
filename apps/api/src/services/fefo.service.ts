import { Pool, PoolClient } from 'pg';
import Decimal from 'decimal.js';

export interface BatchAllocation {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  costPrice: string;
  mrp: string;
  allocatedQty: string;
  currentQuantity: string;
  lineTotal: string;
  cogs: string;
}

export interface FefoAllocationResult {
  success: boolean;
  productId: string;
  requestedQuantity: string;
  totalAllocated: string;
  allocations: BatchAllocation[];
  shortage?: string;
  message?: string;
}

export interface BatchCandidate {
  id: string;
  batch_no: string;
  expiry_date: string;
  cost_price: string;
  mrp: string;
  current_quantity: string;
}

/**
 * FEFO (First-Expired, First-Out) Allocation Engine
 * Selects sellable stock from active, non-expired batches ordered by nearest expiry date.
 * Splits a line item across multiple batches if a single batch cannot fulfill the requested quantity.
 * Uses make_interval(days => $2::int) for interval arithmetic and Decimal for allocation math.
 */
export async function allocateFefo(
  db: Pool | PoolClient,
  productId: string,
  requestedQuantity: string | number,
  options: { forUpdate?: boolean; minShelfLifeDays?: number } = {}
): Promise<FefoAllocationResult> {
  const reqQty = new Decimal(requestedQuantity);
  if (reqQty.lte(0)) {
    throw new Error('Requested quantity must be greater than zero');
  }

  const minShelfLife = Math.max(0, options.minShelfLifeDays || 0);
  const forUpdateClause = options.forUpdate ? 'FOR UPDATE' : '';

  // Query sellable batches: strictly active, non-expired (with min shelf life), positive stock, ordered by expiry_date ASC, id ASC
  // Uses make_interval(days => $2::int) instead of string concatenation
  const query = `
    SELECT 
      id,
      batch_no,
      expiry_date::text,
      cost_price::text,
      mrp::text,
      current_quantity::text
    FROM batches
    WHERE product_id = $1 
      AND is_active = true 
      AND current_quantity > 0
      AND expiry_date >= CURRENT_DATE + make_interval(days => $2::int)
    ORDER BY expiry_date ASC, id ASC
    ${forUpdateClause}
  `;

  const result = await db.query(query, [productId, minShelfLife]);
  const candidates: BatchCandidate[] = result.rows;

  let totalAvailable = new Decimal(0);
  for (const c of candidates) {
    totalAvailable = totalAvailable.plus(new Decimal(c.current_quantity));
  }

  if (totalAvailable.lt(reqQty)) {
    return {
      success: false,
      productId,
      requestedQuantity: reqQty.toFixed(2),
      totalAllocated: '0.00',
      allocations: [],
      shortage: reqQty.minus(totalAvailable).toFixed(2),
      message: `Insufficient non-expired stock. Requested ${reqQty.toFixed(2)}, but only ${totalAvailable.toFixed(2)} available across active batches.`
    };
  }

  const allocations: BatchAllocation[] = [];
  let remainingToAllocate = new Decimal(reqQty);

  for (const c of candidates) {
    if (remainingToAllocate.lte(0)) break;

    const availableInBatch = new Decimal(c.current_quantity);
    const allocateFromThis = Decimal.min(remainingToAllocate, availableInBatch);

    const costPriceDec = new Decimal(c.cost_price);
    const mrpDec = new Decimal(c.mrp);
    const lineTotalDec = allocateFromThis.times(mrpDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const cogsDec = allocateFromThis.times(costPriceDec).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

    allocations.push({
      batchId: c.id,
      batchNo: c.batch_no,
      expiryDate: c.expiry_date,
      costPrice: c.cost_price,
      mrp: c.mrp,
      allocatedQty: allocateFromThis.toFixed(2),
      currentQuantity: c.current_quantity,
      lineTotal: lineTotalDec.toFixed(2),
      cogs: cogsDec.toFixed(4)
    });

    remainingToAllocate = remainingToAllocate.minus(allocateFromThis);
  }

  return {
    success: true,
    productId,
    requestedQuantity: reqQty.toFixed(2),
    totalAllocated: reqQty.minus(remainingToAllocate).toFixed(2),
    allocations
  };
}

/**
 * Reconciles batch stock: asserts SUM(qty_change) from stock_movements equals current_quantity strictly in SQL.
 */
export async function reconcileBatchStock(db: Pool | PoolClient, batchId: string): Promise<{
  batchId: string;
  batchNo: string;
  currentQuantity: string;
  movementSum: string;
  reconciled: boolean;
}> {
  const query = `
    SELECT 
      b.id as batch_id,
      b.batch_no,
      b.current_quantity::text as current_quantity,
      COALESCE(SUM(sm.qty_change), 0.00)::NUMERIC(12,2)::text as movement_sum,
      (b.current_quantity = COALESCE(SUM(sm.qty_change), 0.00)) as reconciled
    FROM batches b
    LEFT JOIN stock_movements sm ON b.id = sm.batch_id
    WHERE b.id = $1
    GROUP BY b.id, b.batch_no, b.current_quantity
  `;

  const res = await db.query(query, [batchId]);
  if (res.rows.length === 0) {
    throw new Error(`Batch '${batchId}' not found`);
  }

  const row = res.rows[0];

  return {
    batchId: row.batch_id,
    batchNo: row.batch_no,
    currentQuantity: row.current_quantity,
    movementSum: row.movement_sum,
    reconciled: Boolean(row.reconciled)
  };
}
