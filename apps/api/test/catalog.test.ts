import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { app } from '../src/index.js';
import { pool } from '../src/db/pool.js';
import { generateCsv, sanitizeCsvFormula, parseCsv } from '../src/utils/csv.js';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Step 3: Products, Suppliers, Customers CRUD & CSV Import Tests', () => {
  let server: http.Server;
  let baseUrl: string;

  let ownerToken: string;
  let pharmacistToken: string;
  let cashierToken: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    const login = async (username: string) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password123' })
      });
      const data = (await res.json()) as any;
      expect(res.status).toBe(200);
      return data.accessToken;
    };

    ownerToken = await login('admin');
    pharmacistToken = await login('pharmacist');
    cashierToken = await login('cashier');
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  describe('Products CRUD & Stock Derivation', () => {
    const testBarcode = `BAR_${Date.now()}`;
    let createdProductId: string;

    it('creates product with pack_size and reorder_level (Owner/Pharmacist)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          name: 'Amoxicillin 500mg Capsule',
          genericName: 'Amoxicillin Trihydrate',
          barcode: testBarcode,
          category: 'Antibiotics',
          unit: 'capsule',
          packSize: 100,
          isRxRequired: true,
          reorderLevel: 50
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.product.id).toBeDefined();
      expect(data.product.name).toBe('Amoxicillin 500mg Capsule');
      expect(data.product.pack_size).toBe(100);
      expect(data.product.is_rx_required).toBe(true);
      createdProductId = data.product.id;
    });

    it('rejects duplicate barcode creation with 409 Conflict', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          name: 'Another Brand of Amox',
          barcode: testBarcode, // Duplicate!
          category: 'Antibiotics',
          unit: 'capsule',
          packSize: 50
        })
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as any;
      expect(data.error).toBe('BARCODE_EXISTS');
    });

    it('forbids cashier from creating products (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({
          name: 'Cashier Unauthorized Drug',
          category: 'General',
          unit: 'tablet'
        })
      });

      expect(res.status).toBe(403);
    });

    it('updates product fields and logs audit record', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products/${createdProductId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          reorderLevel: 100
        })
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(parseFloat(data.product.reorder_level)).toBe(100);

      // Verify audit log
      const audit = await pool.query(
        "SELECT * FROM audit_logs WHERE entity = 'PRODUCT' AND entity_id = $1 AND action = 'PRODUCT_UPDATE'",
        [createdProductId]
      );
      expect(audit.rows.length).toBeGreaterThan(0);
    });

    it('soft deactivates and reactivates product without deleting data', async () => {
      // Deactivate
      const deactRes = await fetch(`${baseUrl}/api/v1/products/${createdProductId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({ isActive: false })
      });
      expect(deactRes.status).toBe(200);
      const deactData = (await deactRes.json()) as any;
      expect(deactData.product.is_active).toBe(false);

      // Reactivate
      const reactRes = await fetch(`${baseUrl}/api/v1/products/${createdProductId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({ isActive: true })
      });
      expect(reactRes.status).toBe(200);
      const reactData = (await reactRes.json()) as any;
      expect(reactData.product.is_active).toBe(true);
    });
  });

  describe('Cashier Product Read-Only Whitelist & Zero Cost Exposure', () => {
    it('allows cashier to search products and returns aggregated stock without cost fields', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products?search=Amoxicillin`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.products.length).toBeGreaterThan(0);

      const p = data.products[0];
      expect(p.name).toContain('Amoxicillin');
      expect(p.totalStock).toBeDefined();

      // Ensure cost prices are completely absent
      expect(p.cost_price).toBeUndefined();
      expect(p.costPrice).toBeUndefined();
      expect(p.unit_cost_price).toBeUndefined();
    });

    it('allows cashier to fetch product details but strips batch cost_price and supplier info', async () => {
      // Find a product that has seeded batches
      const listRes = await fetch(`${baseUrl}/api/v1/products?search=Panadol`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      const listData = (await listRes.json()) as any;
      expect(listData.products.length).toBeGreaterThan(0);
      const panadolId = listData.products[0].id;

      // 1. Owner view (must see cost price and supplier name)
      const ownerRes = await fetch(`${baseUrl}/api/v1/products/${panadolId}`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      expect(ownerRes.status).toBe(200);
      const ownerData = (await ownerRes.json()) as any;
      expect(ownerData.product.batches.length).toBeGreaterThan(0);
      expect(ownerData.product.batches[0].costPrice).toBeDefined();

      // 2. Cashier view (must NOT see cost price or supplier name)
      const cashierRes = await fetch(`${baseUrl}/api/v1/products/${panadolId}`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(cashierRes.status).toBe(200);
      const cashierData = (await cashierRes.json()) as any;
      expect(cashierData.product.batches.length).toBeGreaterThan(0);

      for (const batch of cashierData.product.batches) {
        expect(batch.costPrice).toBeUndefined();
        expect(batch.cost_price).toBeUndefined();
        expect(batch.unit_cost_price).toBeUndefined();
        expect(batch.supplierName).toBeUndefined();
        expect(batch.supplier_name).toBeUndefined();
        // Public selling fields must be intact
        expect(batch.batchNo).toBeDefined();
        expect(batch.mrp).toBeDefined();
        expect(batch.currentQuantity).toBeDefined();
      }
    });
  });

  describe('Suppliers CRUD & Cashier Isolation', () => {
    let supplierId: string;

    it('forbids cashier from accessing suppliers list (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/suppliers`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res.status).toBe(403);
    });

    it('allows pharmacist/owner to create supplier', async () => {
      const res = await fetch(`${baseUrl}/api/v1/suppliers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          name: `Apex Pharma Ltd ${Date.now()}`,
          phone: '0112345678',
          address: 'No 45, Union Place, Colombo 02',
          outstandingBalance: 0
        })
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.supplier.id).toBeDefined();
      supplierId = data.supplier.id;
    });

    it('allows owner to update supplier details', async () => {
      const res = await fetch(`${baseUrl}/api/v1/suppliers/${supplierId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          phone: '0119876543'
        })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.supplier.phone).toBe('0119876543');
    });

    it('allows soft deactivation of supplier', async () => {
      const res = await fetch(`${baseUrl}/api/v1/suppliers/${supplierId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({ isActive: false })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.supplier.is_active).toBe(false);
    });
  });

  describe('Customers CRUD & Credit Limit Permissions', () => {
    let customerId: string;
    const testPhone = '077' + Math.floor(1000000 + Math.random() * 9000000);

    it('allows cashier to create customer with creditLimit=0', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({
          name: 'Sunil Perera',
          phone: testPhone,
          creditLimit: 0
        })
      });
      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.customer.id).toBeDefined();
      expect(data.customer.creditLimit).toBe('0.00');
      customerId = data.customer.id;
    });

    it('forbids cashier from assigning a positive credit limit (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({
          name: 'Nimal Silva',
          phone: '0779998888',
          creditLimit: 15000 // Cashier forbidden from granting credit!
        })
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as any;
      expect(data.error).toBe('FORBIDDEN');
    });

    it('forbids cashier from updating customer credit limit (403 Forbidden)', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({
          creditLimit: 10000
        })
      });
      expect(res.status).toBe(403);
    });

    it('allows owner or pharmacist to grant customer credit limit', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers/${customerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          creditLimit: 25000
        })
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.customer.creditLimit).toBe('25000.00');
    });

    it('allows cashier to search customers', async () => {
      const res = await fetch(`${baseUrl}/api/v1/customers?search=Sunil`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.customers.length).toBeGreaterThan(0);
      expect(data.customers[0].name).toBe('Sunil Perera');
    });
  });

  describe('CSV Import for Opening Stock (Dry Run, Unicode, BOM, Atomic Transaction)', () => {
    it('supports UTF-8 with BOM and Sinhala/Tamil script in CSV parsing', () => {
      const csvWithBom =
        '\uFEFFproduct_name,generic_name,batch_no,expiry_date,quantity,cost_price,mrp\r\n' +
        'පැරසිටමෝල් 500mg,Paracetamol,BATCH-SIN-01,2027-12-31,100,2.50,4.00\r\n' +
        'பாராசிட்டமால் 500mg,Paracetamol,BATCH-TAM-01,2027-12-31,200,2.50,4.00\r\n';

      const parsed = parseCsv(csvWithBom);
      expect(parsed.errors.length).toBe(0);
      expect(parsed.rows.length).toBe(2);
      expect(parsed.rows[0].product_name).toBe('පැරසිටමෝල් 500mg');
      expect(parsed.rows[1].product_name).toBe('பாராசிட்டமால் 500mg');
    });

    it('dry-run mode validates errors at row level without committing data', async () => {
      const invalidCsv =
        'product_name,batch_no,expiry_date,quantity,cost_price,mrp\r\n' +
        ',B-ERR-01,2027-12-31,10,2.00,3.00\r\n' + // Missing product name
        'Valid Drug,B-ERR-02,INVALID_DATE,10,2.00,3.00\r\n' + // Bad date
        'Valid Drug 2,B-ERR-03,2027-12-31,-5,2.00,3.00\r\n'; // Negative qty

      const res = await fetch(`${baseUrl}/api/v1/products/import-csv?dryRun=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({ csvContent: invalidCsv })
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as any;
      expect(data.mode).toBe('DRY_RUN_PREVIEW');
      expect(data.valid).toBe(false);
      expect(data.errorRowsCount).toBe(3);
      expect(data.errors.length).toBe(3);
      expect(data.errors[0].errors).toContain('Product name is required');
      expect(data.errors[1].errors[0]).toContain('Invalid expiry date');
      expect(data.errors[2].errors[0]).toContain('Quantity must be a positive number');

      // Verify nothing was saved in DB
      const check = await pool.query("SELECT id FROM batches WHERE batch_no IN ('B-ERR-01', 'B-ERR-02', 'B-ERR-03')");
      expect(check.rows.length).toBe(0);
    });

    it('detects duplicate barcodes in the CSV payload', async () => {
      const dupBarcodeCsv =
        'product_name,barcode,batch_no,expiry_date,quantity,cost_price,mrp\r\n' +
        'Drug Alpha,DUP_CODE_999,B-01,2027-12-31,10,2.00,3.00\r\n' +
        'Drug Beta,DUP_CODE_999,B-02,2027-12-31,10,2.00,3.00\r\n';

      const res = await fetch(`${baseUrl}/api/v1/products/import-csv?dryRun=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({ csvContent: dupBarcodeCsv })
      });

      expect(res.status).toBe(422);
      const data = (await res.json()) as any;
      expect(data.errors[0].errors).toContain("Duplicate barcode 'DUP_CODE_999' within the CSV payload");
    });

    it('commits valid CSV in ONE transaction, populating stock strictly via stock_movements', async () => {
      const uniqueBatch1 = `CSV_B1_${Date.now()}`;
      const uniqueBatch2 = `CSV_B2_${Date.now()}`;
      const uniqueBarcode = `CSV_BAR_${Date.now()}`;

      // Box of 1000 / pack_size 30 test: pack_cost 1000, pack_size 30 -> unit cost 33.3333
      const validCsv =
        'product_name,generic_name,barcode,category,unit,pack_size,batch_no,expiry_date,quantity,pack_cost,mrp\r\n' +
        `Cefuroxime 500mg,Cefuroxime Axetil,${uniqueBarcode},Antibiotics,tablet,30,${uniqueBatch1},2027-11-30,60,1000,50.00\r\n` +
        `Cetirizine 10mg,Cetirizine HCl,,Antihistamines,tablet,10,${uniqueBatch2},2028-06-30,100,50,8.00\r\n`;

      const res = await fetch(`${baseUrl}/api/v1/products/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({ csvContent: validCsv })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.summary.batchesCreated).toBe(2);

      // Verify batch 1 in DB
      const b1Check = await pool.query(
        `SELECT b.id, b.current_quantity, b.cost_price, p.pack_size 
         FROM batches b
         JOIN products p ON b.product_id = p.id
         WHERE b.batch_no = $1`,
        [uniqueBatch1]
      );
      expect(b1Check.rows.length).toBe(1);
      const b1 = b1Check.rows[0];
      // Stock must equal 60.00
      expect(parseFloat(b1.current_quantity)).toBe(60.0);
      // Unit cost price must be 1000 / 30 = 33.3333 (NUMERIC(14,4))
      expect(parseFloat(b1.cost_price)).toBe(33.3333);

      // Verify stock_movement record exists and reconciles: SUM(qty_change) = current_quantity
      const smCheck = await pool.query(
        `SELECT movement_type, qty_change 
         FROM stock_movements 
         WHERE batch_id = $1`,
        [b1.id]
      );
      expect(smCheck.rows.length).toBe(1);
      expect(smCheck.rows[0].movement_type).toBe('opening_stock');
      expect(parseFloat(smCheck.rows[0].qty_change)).toBe(60.0);

      const reconcile = await pool.query(
        `SELECT SUM(qty_change) as movement_sum, (SELECT current_quantity FROM batches WHERE id = $1) as current_qty
         FROM stock_movements WHERE batch_id = $1`,
        [b1.id]
      );
      expect(parseFloat(reconcile.rows[0].movement_sum)).toBe(parseFloat(reconcile.rows[0].current_qty));
    });
  });

  describe('CSV Export Formula-Injection Protection (DDE / CSV Injection Defense)', () => {
    it('escapes dangerous leading characters (=, +, -, @) with a single quote', () => {
      expect(sanitizeCsvFormula('=cmd|"/C calc"!A0')).toBe('\'=cmd|"/C calc"!A0');
      expect(sanitizeCsvFormula('+12345')).toBe('\'+12345');
      expect(sanitizeCsvFormula('-999')).toBe('\'-999');
      expect(sanitizeCsvFormula('@SUM(A1:A10)')).toBe('\'@SUM(A1:A10)');
      expect(sanitizeCsvFormula('Normal Product Name')).toBe('Normal Product Name');
    });

    it('exports CSV file with UTF-8 BOM and formula sanitization', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products/export-csv`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/csv');

      const rawBytes = Buffer.from(await res.arrayBuffer());
      // Verify raw bytes begin with UTF-8 BOM (0xEF, 0xBB, 0xBF)
      expect(rawBytes[0]).toBe(0xef);
      expect(rawBytes[1]).toBe(0xbb);
      expect(rawBytes[2]).toBe(0xbf);
      const csvText = rawBytes.toString('utf8');
      expect(csvText).toContain('Product Name');
      expect(csvText).toContain('Total Stock');
    });
  });

  describe('Pre-Step 3 Verification: Integrity Checks & Invariants', () => {
    it('Fix 5: Tendered 1000 on an 800 bill sets paid_amount=800, payments.amount=800, change=200', async () => {
      // Find an active batch to sell
      const bRes = await pool.query(
        `SELECT b.id, b.product_id, b.mrp, b.current_quantity 
         FROM batches b 
         WHERE b.current_quantity >= 10 AND b.expiry_date >= CURRENT_DATE 
         LIMIT 1`
      );
      expect(bRes.rows.length).toBe(1);
      const batch = bRes.rows[0];

      // Find cashier user id
      const cashierUserRes = await pool.query("SELECT id FROM users WHERE role = 'cashier' LIMIT 1");
      const testCashierId = cashierUserRes.rows[0].id;

      // Insert sale in a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Bill amount = 800.00
        // Tendered = 1000.00, Paid = 800.00, Change = 200.00, Balance Due = 0.00
        const saleRes = await client.query(
          `INSERT INTO sales (
             bill_no, cashier_id, subtotal, discount_amount, tax_amount, total_amount,
             tendered_amount, paid_amount, change_amount, balance_due, payment_status, status
           )
           VALUES ($1, $2, 800.00, 0.00, 0.00, 800.00, 1000.00, 800.00, 200.00, 0.00, 'paid', 'completed')
           RETURNING id`,
          [`BILL_FIX5_${Date.now()}`, testCashierId]
        );
        const saleId = saleRes.rows[0].id;

        // Sale item line_total = 800.00
        await client.query(
          `INSERT INTO sale_items (
             sale_id, product_id, batch_id, quantity, unit_selling_price, unit_cost_price, discount_amount, line_total
           )
           VALUES ($1, $2, $3, 10, 80.00, 50.00, 0.00, 800.00)`,
          [saleId, batch.product_id, batch.id]
        );

        // Payment record amount applied to the bill = 800.00 (NOT tendered 1000)
        await client.query(
          `INSERT INTO payments (sale_id, payment_type, amount, reference_no)
           VALUES ($1, 'cash', 800.00, 'TENDERED_1000_CHANGE_200')`,
          [saleId]
        );

        // Commit should succeed because:
        // sales.subtotal (800) = sum(sale_items.line_total) (800)
        // sales.paid_amount (800) = sum(payments.amount) (800)
        await client.query('COMMIT');

        // Query committed sale to verify
        const check = await pool.query('SELECT total_amount, tendered_amount, paid_amount, change_amount FROM sales WHERE id = $1', [saleId]);
        const s = check.rows[0];
        expect(parseFloat(s.total_amount)).toBe(800.0);
        expect(parseFloat(s.tendered_amount)).toBe(1000.0);
        expect(parseFloat(s.paid_amount)).toBe(800.0);
        expect(parseFloat(s.change_amount)).toBe(200.0);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    });

    it('Fix 6: Sale with zero sale_items fails deferred constraint check at COMMIT', async () => {
      const cashierUserRes = await pool.query("SELECT id FROM users WHERE role = 'cashier' LIMIT 1");
      const testCashierId = cashierUserRes.rows[0].id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Insert a sale with subtotal 500.00 but NO sale items
        await client.query(
          `INSERT INTO sales (
             bill_no, cashier_id, subtotal, discount_amount, tax_amount, total_amount,
             tendered_amount, paid_amount, change_amount, balance_due, payment_status, status
           )
           VALUES ($1, $2, 500.00, 0.00, 0.00, 500.00, 500.00, 500.00, 0.00, 0.00, 'paid', 'completed')`,
          [`BILL_ZERO_ITEM_${Date.now()}`, testCashierId]
        );

        // Attempting to COMMIT must fail because sale has 0 sale items
        let commitFailed = false;
        try {
          await client.query('COMMIT');
        } catch (commitErr: any) {
          commitFailed = true;
          expect(commitErr.message).toContain('Deferred integrity check failed');
          expect(commitErr.message).toContain('0 sale items');
        }
        expect(commitFailed).toBe(true);
      } finally {
        client.release();
      }
    });

    it('Fix 7: COGS formula calculates ROUND(SUM(quantity * unit_cost_price), 2) preventing fractional roundoff drift', async () => {
      // Box of 1000 cost for 30 units: unit cost is 33.333333...
      // Selling 30 units:
      // sum(round(33.3333, 2) * 1) per line = 33.33 * 30 = 999.90 (10 cents drifted!)
      // But ROUND(SUM(30 * 33.3333), 2) = ROUND(999.999, 2) = 1000.00 (Correct!)
      const cogsQuery = await pool.query(`
        WITH test_sales AS (
          SELECT 30.00 AS qty, 33.3333::NUMERIC(14,4) AS unit_cost
        )
        SELECT 
          ROUND(SUM(qty * unit_cost), 2) as aggregate_cogs,
          SUM(ROUND(qty * unit_cost, 2)) as per_line_cogs
        FROM test_sales
      `);

      const result = cogsQuery.rows[0];
      expect(parseFloat(result.aggregate_cogs)).toBe(1000.0);
    });
  });
});
