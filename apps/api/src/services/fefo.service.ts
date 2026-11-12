import { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool.js';

export interface BatchAllocation {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  costPrice: number;
  mrp: number;
  allocatedQty: number;
  currentQuantity: number;
}

export interface FefoAllocationResult {
  success: boolean;
  productId: string;
  requestedQuantity: number;
  totalAllocated: number;
  allocations: BatchAllocation[];
  shortage?: number;
  message?: string;
}

export interface BatchCandidate {
  id: string;
  batch_no: string;
  expiry_date: string;
  cost_price: string;
  mrp: string;
  current_quantity: string;
  is_expired: boolean;
}

/**
 * FEFO (First-Expired, First-Out) Allocation Engine
 * Selects sellable stock from active, non-expired batches ordered by nearest expiry date.
 * Splits a line item across multiple batches if a single batch cannot fulfill the requested quantity.
 */
export async function allocateFefo(
  db: Pool | PoolClient,
  productId: string,
  requestedQuantity: number,
  options: { forUpdate?: boolean } = {}
): Promise<FefoAllocationResult> {
  if (requestedQuantity <= 0) {
    throw new Error('Requested quantity must be greater than zero');
  }

  // Query sellable batches: strictly active, non-expired, positive stock, ordered by expiry_date ASC
  const forUpdateClause = options.forUpdate ? 'FOR UPDATE' : '';
  const query = `
    SELECT 
      id,
      batch_no,
      expiry_date::text,
      cost_price,
      mrp,
      current_quantity,
      (expiry_date < CURRENT_DATE) as is_expired
    FROM batches
    WHERE product_id = $1 
      AND is_active = true 
      AND current_quantity > 0
      AND expiry_date >= CURRENT_DATE
    ORDER BY expiry_date ASC, created_at ASC
    ${forUpdateClause}
  `;

  const result = await db.query(query, [productId]);
  const candidates: BatchCandidate[] = result.rows;

  let totalAvailable = 0;
  for (const c of candidates) {
    totalAvailable += parseFloat(c.current_quantity);
  }

  if (totalAvailable < requestedQuantity) {
    return {
      success: false,
      productId,
      requestedQuantity,
      totalAllocated: 0,
      allocations: [],
      shortage: requestedQuantity - totalAvailable,
      message: `Insufficient non-expired stock. Requested ${requestedQuantity}, but only ${totalAvailable} available across active batches.`
    };
  }

  const allocations: BatchAllocation[] = [];
  let remainingToAllocate = requestedQuantity;

  for (const c of candidates) {
    if (remainingToAllocate <= 0) break;

    const availableInBatch = parseFloat(c.current_quantity);
    const allocateFromThis = Math.min(remainingToAllocate, availableInBatch);

    allocations.push({
      batchId: c.id,
      batchNo: c.batch_no,
      expiryDate: c.expiry_date,
      costPrice: parseFloat(c.cost_price),
      mrp: parseFloat(c.mrp),
      allocatedQty: allocateFromThis,
      currentQuantity: availableInBatch
    });

    remainingToAllocate -= allocateFromThis;
  }

  return {
    success: true,
    productId,
    requestedQuantity,
    totalAllocated: requestedQuantity - remainingToAllocate,
    allocations
  };
}

/**
 * Reconciles batch stock: asserts SUM(qty_change) from stock_movements equals current_quantity.
 */
export async function reconcileBatchStock(db: Pool | PoolClient, batchId: string): Promise<{
  batchId: string;
  batchNo: string;
  currentQuantity: number;
  movementSum: number;
  reconciled: boolean;
}> {
  const query = `
    SELECT 
      b.id as batch_id,
      b.batch_no,
      b.current_quantity,
      COALESCE(SUM(sm.qty_change), 0.00)::NUMERIC(12,2) as movement_sum
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
  const currentQuantity = parseFloat(row.current_quantity);
  const movementSum = parseFloat(row.movement_sum);

  return {
    batchId: row.batch_id,
    batchNo: row.batch_no,
    currentQuantity,
    movementSum,
    reconciled: currentQuantity === movementSum
  };
}
