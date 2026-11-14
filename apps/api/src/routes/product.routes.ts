import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { authenticate, getClientIp } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { logAudit } from '../services/audit.service.js';
import { AuthenticatedRequest } from '../types/auth.js';
import { parseCsv, generateCsv, CSV_MAX_FILE_SIZE_BYTES, CSV_MAX_ROW_COUNT } from '../utils/csv.js';

const router = Router();

// Validation Schemas
const createProductSchema = z.object({
  name: z.string().min(1, 'Product name is required'),
  genericName: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  category: z.string().min(1, 'Category is required'),
  unit: z.string().min(1, 'Unit is required (e.g. tablet, capsule, bottle)'),
  packSize: z.number().int().min(1, 'Pack size must be at least 1').default(1),
  isRxRequired: z.boolean().default(false),
  reorderLevel: z.number().min(0, 'Reorder level cannot be negative').default(10)
});

const updateProductSchema = z.object({
  name: z.string().min(1).optional(),
  genericName: z.string().optional().nullable(),
  barcode: z.string().optional().nullable(),
  category: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  packSize: z.number().int().min(1).optional(),
  isRxRequired: z.boolean().optional(),
  reorderLevel: z.number().min(0).optional(),
  isActive: z.boolean().optional()
});

/**
 * GET /api/v1/products
 * List and search products with dynamically aggregated stock
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const { search, category, isRxRequired, isActive } = req.query;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
  const offset = parseInt(req.query.offset as string, 10) || 0;

  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (search && typeof search === 'string') {
    conditions.push(`(p.name ILIKE $${idx} OR p.generic_name ILIKE $${idx} OR p.barcode = $${idx + 1})`);
    values.push(`%${search.trim()}%`);
    values.push(search.trim());
    idx += 2;
  }

  if (category && typeof category === 'string') {
    conditions.push(`p.category = $${idx++}`);
    values.push(category);
  }

  if (isRxRequired !== undefined) {
    conditions.push(`p.is_rx_required = $${idx++}`);
    values.push(isRxRequired === 'true');
  }

  if (isActive !== undefined) {
    conditions.push(`p.is_active = $${idx++}`);
    values.push(isActive === 'true');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) FROM products p ${whereClause}`,
      values.slice(0, idx - 1)
    );
    const total = parseInt(countRes.rows[0].count, 10);

    // Stock is strictly derived by summing non-expired active batches.current_quantity
    // Expired batches are calculated and reported separately
    const query = `
      SELECT 
        p.id,
        p.name,
        p.generic_name,
        p.barcode,
        p.category,
        p.unit,
        p.pack_size,
        p.is_rx_required,
        p.reorder_level,
        p.is_active,
        p.created_at,
        p.updated_at,
        COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0)::NUMERIC(12,2) AS total_stock,
        COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date < CURRENT_DATE), 0)::NUMERIC(12,2) AS expired_quantity,
        COUNT(b.id) FILTER (WHERE b.current_quantity > 0 AND b.expiry_date >= CURRENT_DATE)::INT AS active_batch_count,
        MIN(b.mrp) FILTER (WHERE b.current_quantity > 0 AND b.expiry_date >= CURRENT_DATE) AS min_mrp,
        MAX(b.mrp) FILTER (WHERE b.current_quantity > 0 AND b.expiry_date >= CURRENT_DATE) AS max_mrp
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
      ${whereClause}
      GROUP BY p.id
      ORDER BY p.name ASC
      LIMIT $${idx++} OFFSET $${idx++}
    `;

    values.push(limit, offset);
    const result = await pool.query(query, values);

    return res.json({
      total,
      limit,
      offset,
      products: result.rows.map((p) => ({
        id: p.id,
        name: p.name,
        genericName: p.generic_name,
        barcode: p.barcode,
        category: p.category,
        unit: p.unit,
        packSize: p.pack_size,
        isRxRequired: p.is_rx_required,
        reorderLevel: p.reorder_level,
        isActive: p.is_active,
        totalStock: p.total_stock,
        expiredQuantity: p.expired_quantity,
        expiredStock: p.expired_quantity,
        activeBatchCount: p.active_batch_count,
        mrp: p.min_mrp ? (p.min_mrp === p.max_mrp ? p.min_mrp : `${p.min_mrp} - ${p.max_mrp}`) : null,
        createdAt: p.created_at,
        updatedAt: p.updated_at
      }))
    });
  } catch (error) {
    console.error('List products error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch products' });
  }
});

/**
 * GET /api/v1/products/export-csv
 * Export product catalog as CSV with formula injection sanitization (Owner / Pharmacist)
 */
router.get('/export-csv', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.name,
        p.generic_name,
        p.barcode,
        p.category,
        p.unit,
        p.pack_size,
        p.is_rx_required,
        p.reorder_level,
        p.is_active,
        COALESCE(SUM(b.current_quantity), 0)::NUMERIC(12,2) AS total_stock
      FROM products p
      LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
      GROUP BY p.id
      ORDER BY p.name ASC
    `);

    const headers = [
      { key: 'name', label: 'Product Name' },
      { key: 'generic_name', label: 'Generic Name' },
      { key: 'barcode', label: 'Barcode' },
      { key: 'category', label: 'Category' },
      { key: 'unit', label: 'Unit' },
      { key: 'pack_size', label: 'Pack Size' },
      { key: 'is_rx_required', label: 'Rx Required' },
      { key: 'reorder_level', label: 'Reorder Level' },
      { key: 'total_stock', label: 'Total Stock' },
      { key: 'is_active', label: 'Is Active' }
    ];

    const csvContent = generateCsv(headers, result.rows);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="products_export.csv"');
    return res.status(200).send(csvContent);
  } catch (error) {
    console.error('Export CSV error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to export products CSV' });
  }
});

/**
 * GET /api/v1/products/:id
 * Get single product with active FEFO batches
 */
router.get('/:id', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const productId = String(req.params.id);

  try {
    const prodRes = await pool.query(
      `SELECT 
         p.*,
         COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date >= CURRENT_DATE), 0)::NUMERIC(12,2) AS total_stock,
         COALESCE(SUM(b.current_quantity) FILTER (WHERE b.expiry_date < CURRENT_DATE), 0)::NUMERIC(12,2) AS expired_quantity
       FROM products p
       LEFT JOIN batches b ON p.id = b.product_id AND b.is_active = true
       WHERE p.id = $1
       GROUP BY p.id`,
      [productId]
    );

    if (prodRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    const product = prodRes.rows[0];

    const isCashier = req.user?.role === 'cashier';

    // Query active batches ordered by FEFO with explicit projection whitelist for cashier
    const batchQuery = isCashier
      ? `SELECT 
           b.id,
           b.batch_no,
           b.expiry_date,
           b.mrp,
           b.initial_quantity,
           b.current_quantity,
           b.is_active,
           (b.expiry_date < CURRENT_DATE) as is_expired
         FROM batches b
         WHERE b.product_id = $1 AND b.is_active = true
         ORDER BY b.expiry_date ASC, b.created_at ASC`
      : `SELECT 
           b.id,
           b.batch_no,
           b.expiry_date,
           b.cost_price,
           b.mrp,
           b.initial_quantity,
           b.current_quantity,
           b.is_active,
           s.name as supplier_name,
           (b.expiry_date < CURRENT_DATE) as is_expired
         FROM batches b
         LEFT JOIN suppliers s ON b.supplier_id = s.id
         WHERE b.product_id = $1 AND b.is_active = true
         ORDER BY b.expiry_date ASC, b.created_at ASC`;

    const batchRes = await pool.query(batchQuery, [productId]);

    return res.json({
      product: {
        id: product.id,
        name: product.name,
        genericName: product.generic_name,
        barcode: product.barcode,
        category: product.category,
        unit: product.unit,
        packSize: product.pack_size,
        isRxRequired: product.is_rx_required,
        reorderLevel: product.reorder_level,
        isActive: product.is_active,
        totalStock: product.total_stock,
        expiredQuantity: product.expired_quantity,
        expiredStock: product.expired_quantity,
        batches: batchRes.rows.map((b) => {
          const item: Record<string, any> = {
            id: b.id,
            batchNo: b.batch_no,
            expiryDate: b.expiry_date,
            mrp: b.mrp,
            initialQuantity: b.initial_quantity,
            currentQuantity: b.current_quantity,
            isExpired: b.is_expired
          };
          if (!isCashier) {
            item.costPrice = b.cost_price;
            item.supplierName = b.supplier_name;
          }
          return item;
        })
      }
    });
  } catch (error) {
    console.error('Get product error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch product details' });
  }
});

/**
 * POST /api/v1/products
 * Create product (Owner / Pharmacist only)
 */
router.post('/', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const parseResult = createProductSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const data = parseResult.data;

  try {
    if (data.barcode) {
      const barcodeCheck = await pool.query('SELECT id FROM products WHERE barcode = $1', [data.barcode]);
      if (barcodeCheck.rows.length > 0) {
        return res.status(409).json({
          error: 'BARCODE_EXISTS',
          message: `Product with barcode '${data.barcode}' already exists`
        });
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO products (
         name, generic_name, barcode, category, unit, pack_size, is_rx_required, reorder_level, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       RETURNING *`,
      [
        data.name,
        data.genericName || null,
        data.barcode || null,
        data.category,
        data.unit,
        data.packSize,
        data.isRxRequired,
        data.reorderLevel
      ]
    );

    const newProduct = insertRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'PRODUCT_CREATE',
      entity: 'PRODUCT',
      entityId: newProduct.id,
      afterState: newProduct,
      ipAddress
    });

    return res.status(201).json({
      message: 'Product created successfully',
      product: newProduct
    });
  } catch (error) {
    console.error('Create product error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create product' });
  }
});

/**
 * PUT /api/v1/products/:id
 * Update product (Owner / Pharmacist only)
 */
router.put('/:id', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const productId = String(req.params.id);
  const parseResult = updateProductSchema.safeParse(req.body);

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      details: parseResult.error.format()
    });
  }

  const data = parseResult.data;

  try {
    const existingRes = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (existingRes.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }
    const beforeProduct = existingRes.rows[0];

    if (data.barcode && data.barcode !== beforeProduct.barcode) {
      const barcodeCheck = await pool.query('SELECT id FROM products WHERE barcode = $1 AND id != $2', [data.barcode, productId]);
      if (barcodeCheck.rows.length > 0) {
        return res.status(409).json({
          error: 'BARCODE_EXISTS',
          message: `Product with barcode '${data.barcode}' already exists`
        });
      }
    }

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined) { updates.push(`name = $${idx++}`); values.push(data.name); }
    if (data.genericName !== undefined) { updates.push(`generic_name = $${idx++}`); values.push(data.genericName); }
    if (data.barcode !== undefined) { updates.push(`barcode = $${idx++}`); values.push(data.barcode); }
    if (data.category !== undefined) { updates.push(`category = $${idx++}`); values.push(data.category); }
    if (data.unit !== undefined) { updates.push(`unit = $${idx++}`); values.push(data.unit); }
    if (data.packSize !== undefined) { updates.push(`pack_size = $${idx++}`); values.push(data.packSize); }
    if (data.isRxRequired !== undefined) { updates.push(`is_rx_required = $${idx++}`); values.push(data.isRxRequired); }
    if (data.reorderLevel !== undefined) { updates.push(`reorder_level = $${idx++}`); values.push(data.reorderLevel); }
    if (data.isActive !== undefined) { updates.push(`is_active = $${idx++}`); values.push(data.isActive); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'NO_CHANGES', message: 'No fields provided to update' });
    }

    updates.push(`updated_at = NOW()`);
    values.push(productId);

    const updateQuery = `
      UPDATE products
      SET ${updates.join(', ')}
      WHERE id = $${idx}
      RETURNING *
    `;

    const updateRes = await pool.query(updateQuery, values);
    const updatedProduct = updateRes.rows[0];

    await logAudit({
      userId: req.user!.id,
      action: 'PRODUCT_UPDATE',
      entity: 'PRODUCT',
      entityId: productId,
      beforeState: beforeProduct,
      afterState: updatedProduct,
      ipAddress
    });

    return res.json({
      message: 'Product updated successfully',
      product: updatedProduct
    });
  } catch (error) {
    console.error('Update product error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update product' });
  }
});

/**
 * PATCH /api/v1/products/:id/status
 * Toggle product active status (Owner / Pharmacist only)
 */
router.patch('/:id/status', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const productId = String(req.params.id);

  try {
    const existing = await pool.query('SELECT id, is_active FROM products WHERE id = $1', [productId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    const currentStatus = existing.rows[0].is_active;
    const newStatus = req.body.isActive !== undefined ? Boolean(req.body.isActive) : !currentStatus;

    const resUpdate = await pool.query(
      `UPDATE products SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active`,
      [newStatus, productId]
    );

    await logAudit({
      userId: req.user!.id,
      action: 'PRODUCT_STATUS_CHANGE',
      entity: 'PRODUCT',
      entityId: productId,
      beforeState: { isActive: currentStatus },
      afterState: { isActive: newStatus },
      ipAddress
    });

    return res.json({
      message: `Product ${newStatus ? 'activated' : 'deactivated'} successfully`,
      product: resUpdate.rows[0]
    });
  } catch (error) {
    console.error('Product status error:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to toggle product status' });
  }
});

/**
 * POST /api/v1/products/import-csv
 * CSV import for opening stock with dry-run validation preview and row-level error reporting
 */
router.post('/import-csv', authenticate, requireRoles('owner', 'pharmacist'), async (req: AuthenticatedRequest, res: Response) => {
  const ipAddress = getClientIp(req);
  const isDryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

  // File size limit check (5MB)
  if (typeof req.body?.csvContent === 'string') {
    if (Buffer.byteLength(req.body.csvContent, 'utf8') > CSV_MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({
        error: 'PAYLOAD_TOO_LARGE',
        message: 'CSV file size exceeds the 5MB limit'
      });
    }
  }

  let rawRows: Record<string, string>[] = [];

  if (typeof req.body?.csvContent === 'string') {
    const parsed = parseCsv(req.body.csvContent);
    if (parsed.errors.length > 0 && parsed.rows.length === 0) {
      return res.status(400).json({
        error: 'CSV_PARSE_FAILED',
        errors: parsed.errors
      });
    }
    rawRows = parsed.rows;
  } else if (Array.isArray(req.body?.rows)) {
    rawRows = req.body.rows;
  } else {
    return res.status(400).json({
      error: 'INVALID_PAYLOAD',
      message: 'Expected { csvContent: string } or { rows: Array } in request body'
    });
  }

  if (rawRows.length === 0) {
    return res.status(400).json({
      error: 'EMPTY_IMPORT',
      message: 'No data rows found in CSV import'
    });
  }

  // Row limit check (5,000 rows)
  if (rawRows.length > CSV_MAX_ROW_COUNT) {
    return res.status(400).json({
      error: 'ROW_LIMIT_EXCEEDED',
      message: `CSV import exceeds maximum limit of ${CSV_MAX_ROW_COUNT} rows`
    });
  }

  // Row-level validation
  interface RowValidation {
    rowNumber: number;
    isValid: boolean;
    errors: string[];
    data?: {
      productName: string;
      genericName: string | null;
      barcode: string | null;
      category: string;
      unit: string;
      packSize: number;
      isRxRequired: boolean;
      reorderLevel: number;
      batchNo: string;
      expiryDate: string; // ISO format YYYY-MM-DD
      quantity: number;
      costPrice: number;
      mrp: number;
    };
  }

  const validations: RowValidation[] = [];
  const seenBarcodes = new Set<string>();

  // Pre-load existing barcodes to detect conflicting assignments
  const incomingBarcodes = rawRows
    .map((r) => (r.barcode ? r.barcode.trim() : null))
    .filter((b): b is string => Boolean(b));

  const existingBarcodeMap = new Map<string, string>(); // barcode -> product name
  if (incomingBarcodes.length > 0) {
    const existingBarcodeRes = await pool.query(
      `SELECT barcode, name FROM products WHERE barcode = ANY($1)`,
      [incomingBarcodes]
    );
    for (const row of existingBarcodeRes.rows) {
      existingBarcodeMap.set(row.barcode, row.name.toLowerCase().trim());
    }
  }

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    const rowNum = i + 2; // header is row 1
    const errors: string[] = [];

    // Number validators for strict CSV validation
    const isValidPositiveNumber = (val: string | undefined): boolean => {
      if (!val || val.trim() === '') return false;
      return /^\d+(\.\d+)?$/.test(val.trim()) && parseFloat(val.trim()) > 0;
    };

    const isValidNonNegativeNumber = (val: string | undefined): boolean => {
      if (!val || val.trim() === '') return false;
      return /^\d+(\.\d+)?$/.test(val.trim()) && parseFloat(val.trim()) >= 0;
    };

    const isValidPositiveInt = (val: string | undefined): boolean => {
      if (!val || val.trim() === '') return false;
      return /^\d+$/.test(val.trim()) && parseInt(val.trim(), 10) > 0;
    };

    // Text fields are never altered - preserved intact (e.g. "+Vitamin C")
    const productName = (r.product_name || r.product || r.name || '').trim();
    const genericName = (r.generic_name || r.generic || null)?.trim() || null;
    const barcode = r.barcode ? r.barcode.trim() : null;
    const category = (r.category || 'General').trim();
    const unit = (r.unit || 'tablet').trim();
    const isRxRequired = String(r.is_rx_required || r.rx || 'false').toLowerCase() === 'true';

    // Pack size validation
    const packSizeRaw = r.pack_size;
    let packSize = 1;
    if (packSizeRaw !== undefined && packSizeRaw !== '') {
      if (!isValidPositiveInt(packSizeRaw)) {
        errors.push(`Pack size must be a positive integer, received: '${packSizeRaw}'`);
      } else {
        packSize = parseInt(packSizeRaw.trim(), 10);
      }
    }

    // Reorder level validation
    const reorderLevelRaw = r.reorder_level;
    let reorderLevel = 10;
    if (reorderLevelRaw !== undefined && reorderLevelRaw !== '') {
      if (!isValidNonNegativeNumber(reorderLevelRaw)) {
        errors.push(`Reorder level must be a valid non-negative number, received: '${reorderLevelRaw}'`);
      } else {
        reorderLevel = parseFloat(reorderLevelRaw.trim());
      }
    }

    const batchNo = (r.batch_no || r.batch || '').trim();
    const expiryRaw = (r.expiry_date || r.expiry || '').trim();

    // Quantity validation (must be positive, non-negative, well-formed)
    const qtyRaw = r.quantity || r.qty;
    let quantity = 0;
    if (!qtyRaw || !isValidPositiveNumber(qtyRaw)) {
      errors.push(`Quantity must be a positive number, received: '${qtyRaw}'`);
    } else {
      quantity = parseFloat(qtyRaw.trim());
    }
    
    // Support either per-unit cost or pack cost
    const packCostRaw = r.pack_cost || r.packcost;
    const costPriceRaw = r.cost_price || r.cost || r.unit_cost;
    let costPrice = 0;
    if (costPriceRaw !== undefined && costPriceRaw !== '') {
      if (!isValidNonNegativeNumber(costPriceRaw)) {
        errors.push(`Cost price must be non-negative, received: '${costPriceRaw}'`);
      } else {
        costPrice = parseFloat(costPriceRaw.trim());
      }
    } else if (packCostRaw !== undefined && packCostRaw !== '') {
      if (!isValidNonNegativeNumber(packCostRaw)) {
        errors.push(`Pack cost must be non-negative, received: '${packCostRaw}'`);
      } else {
        const pCost = parseFloat(packCostRaw.trim());
        costPrice = pCost / (packSize > 0 ? packSize : 1);
      }
    }
    // Round per-unit cost to 4 decimal places (NUMERIC(14,4))
    costPrice = Math.round(costPrice * 10000) / 10000;

    // MRP validation
    const mrpRaw = r.mrp || r.selling_price;
    let mrp = 0;
    if (mrpRaw !== undefined && mrpRaw !== '') {
      if (!isValidNonNegativeNumber(mrpRaw)) {
        errors.push(`MRP must be a valid non-negative number, received: '${mrpRaw}'`);
      } else {
        mrp = parseFloat(mrpRaw.trim());
      }
    }

    // Validations
    if (!productName) errors.push('Product name is required');
    if (!batchNo) errors.push('Batch number is required');

    // Date parsing: accept YYYY-MM-DD, or MM/YYYY, or MM-YYYY
    let parsedExpiry: string | null = null;
    if (expiryRaw) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(expiryRaw)) {
        parsedExpiry = expiryRaw;
      } else if (/^(\d{1,2})[\/-](\d{4})$/.test(expiryRaw)) {
        const [, mm, yyyy] = expiryRaw.match(/^(\d{1,2})[\/-](\d{4})$/)!;
        const m = parseInt(mm, 10);
        const lastDay = new Date(parseInt(yyyy, 10), m, 0).getDate();
        parsedExpiry = `${yyyy}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      } else if (!isNaN(Date.parse(expiryRaw))) {
        parsedExpiry = new Date(expiryRaw).toISOString().split('T')[0];
      }
    }

    if (!parsedExpiry) {
      errors.push(`Invalid expiry date format: '${expiryRaw}'. Expected YYYY-MM-DD or MM/YYYY`);
    }

    // Barcode duplicate in CSV check & conflict check against existing DB
    if (barcode) {
      if (seenBarcodes.has(barcode)) {
        errors.push(`Duplicate barcode '${barcode}' within the CSV payload`);
      } else {
        seenBarcodes.add(barcode);
      }

      if (existingBarcodeMap.has(barcode)) {
        const existingName = existingBarcodeMap.get(barcode)!;
        if (existingName !== productName.toLowerCase()) {
          errors.push(`Barcode '${barcode}' already belongs to a different product: '${existingName}'`);
        }
      }
    }

    if (errors.length > 0) {
      validations.push({ rowNumber: rowNum, isValid: false, errors });
    } else {
      validations.push({
        rowNumber: rowNum,
        isValid: true,
        errors: [],
        data: {
          productName,
          genericName,
          barcode,
          category,
          unit,
          packSize,
          isRxRequired,
          reorderLevel,
          batchNo,
          expiryDate: parsedExpiry!,
          quantity,
          costPrice,
          mrp
        }
      });
    }
  }

  const validRows = validations.filter((v) => v.isValid);
  const errorRows = validations.filter((v) => !v.isValid);
  const isAllValid = errorRows.length === 0;

  // Dry-Run Response (or validation failure response)
  if (isDryRun || !isAllValid) {
    return res.status(isAllValid ? 200 : 422).json({
      mode: isDryRun ? 'DRY_RUN_PREVIEW' : 'VALIDATION_FAILED',
      valid: isAllValid,
      totalRows: validations.length,
      validRowsCount: validRows.length,
      errorRowsCount: errorRows.length,
      errors: errorRows.map((e) => ({
        rowNumber: e.rowNumber,
        errors: e.errors
      })),
      preview: validRows.slice(0, 10).map((v) => v.data)
    });
  }

  // Real Import (Atomic Transaction)
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let productsCreated = 0;
    let productsMatched = 0;
    let batchesCreated = 0;

    for (const v of validRows) {
      const d = v.data!;

      // 1. Match or Create Product
      let productId: string;
      let matchedProd = null;

      if (d.barcode) {
        const bRes = await client.query('SELECT id FROM products WHERE barcode = $1', [d.barcode]);
        if (bRes.rows.length > 0) matchedProd = bRes.rows[0];
      }

      if (!matchedProd) {
        const nRes = await client.query('SELECT id FROM products WHERE LOWER(name) = LOWER($1)', [d.productName]);
        if (nRes.rows.length > 0) matchedProd = nRes.rows[0];
      }

      if (matchedProd) {
        productId = matchedProd.id;
        productsMatched++;
      } else {
        const newPRes = await client.query(
          `INSERT INTO products (
             name, generic_name, barcode, category, unit, pack_size, is_rx_required, reorder_level, is_active
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
           RETURNING id`,
          [
            d.productName,
            d.genericName,
            d.barcode,
            d.category,
            d.unit,
            d.packSize,
            d.isRxRequired,
            d.reorderLevel
          ]
        );
        productId = newPRes.rows[0].id;
        productsCreated++;
      }

      // 2. Insert Batch (starting at 0.00 current_quantity)
      const batchRes = await client.query(
        `INSERT INTO batches (
           product_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity, is_active
         )
         VALUES ($1, $2, $3, $4, $5, $6, 0.00, true)
         RETURNING id`,
        [productId, d.batchNo, d.expiryDate, d.costPrice, d.mrp, d.quantity]
      );
      const batchId = batchRes.rows[0].id;
      batchesCreated++;

      // 3. Create Opening Stock Movement (triggers automatic batch stock addition)
      await client.query(
        `INSERT INTO stock_movements (
           batch_id, movement_type, qty_change, ref_type, ref_id, created_by, created_at
         )
         VALUES ($1, 'opening_stock', $2, 'opening_stock_csv', $1, $3, NOW())`,
        [batchId, d.quantity, req.user!.id]
      );
    }

    await logAudit({
      userId: req.user!.id,
      action: 'OPENING_STOCK_CSV_IMPORT',
      entity: 'INVENTORY',
      entityId: 'batch_import',
      afterState: {
        totalRows: validRows.length,
        productsCreated,
        productsMatched,
        batchesCreated
      },
      ipAddress,
      client
    });

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Opening stock CSV imported successfully',
      summary: {
        totalRowsImported: validRows.length,
        productsCreated,
        productsMatched,
        batchesCreated
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Import CSV transaction error:', error);
    return res.status(500).json({
      error: 'IMPORT_TRANSACTION_FAILED',
      message: (error as Error).message
    });
  } finally {
    client.release();
  }
});

export { router as productRouter };

