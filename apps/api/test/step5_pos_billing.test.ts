import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../src/index.js';
import { pool } from '../src/db/pool.js';
import { Server } from 'http';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { getColomboDateStr, getColomboDateFormatted } from '../src/utils/date.js';
import { sanitizeForAudit, validateIpAddress, logAudit } from '../src/services/audit.service.js';
import { reconcileBatchStock } from '../src/services/fefo.service.js';

describe('Step 5: Core POS Billing Backend Integration Tests', () => {
  let server: Server;
  let baseUrl: string;

  let ownerToken: string;
  let pharmacistToken: string;
  let cashierToken: string;

  let testSupplierId: string;
  let integerProductId: string;
  let fractionalProductId: string;
  let rxProductId: string;
  let multiBatchProductId: string;

  // Helper to create products via API
  const createProduct = async (data: {
    name: string;
    barcode: string;
    category: string;
    unit: string;
    packSize?: number;
    allowFractionalQty?: boolean;
    isRxRequired?: boolean;
  }) => {
    const res = await fetch(`${baseUrl}/api/v1/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        name: data.name,
        barcode: data.barcode,
        category: data.category,
        unit: data.unit,
        packSize: data.packSize || 1,
        reorderLevel: 10,
        isRxRequired: data.isRxRequired || false
      })
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(201);

    if (data.allowFractionalQty) {
      await pool.query('UPDATE products SET allow_fractional_qty = true WHERE id = $1', [body.product.id]);
    }
    return body.product.id as string;
  };

  // Helper to create purchases / batches via GRN API
  const createGrn = async (items: Array<{
    productId: string;
    batchNo: string;
    expiryDate: string;
    packsReceived: number;
    packCost: number;
    packSize: number;
    mrp: number;
  }>) => {
    const invoiceNo = `INV-GRN-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const res = await fetch(`${baseUrl}/api/v1/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        supplierId: testSupplierId,
        invoiceNo,
        purchaseDate: '2026-11-14',
        items
      })
    });
    const data = (await res.json()) as any;
    expect(res.status).toBe(201);
    return data;
  };

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

    // Create supplier
    const supRes = await fetch(`${baseUrl}/api/v1/suppliers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        name: `Billing Supplier ${Date.now()}`,
        phone: `077${Math.floor(1000000 + Math.random() * 9000000)}`,
        address: 'Colombo Warehouse',
        outstandingBalance: 0.00
      })
    });
    const supData = (await supRes.json()) as any;
    expect(supRes.status).toBe(201);
    testSupplierId = supData.supplier.id;

    // Create products
    integerProductId = await createProduct({
      name: `Amoxicillin 500mg ${Date.now()}`,
      barcode: `AMOX_${Date.now()}`,
      category: 'Antibiotics',
      unit: 'capsule',
      packSize: 10,
      allowFractionalQty: false
    });

    fractionalProductId = await createProduct({
      name: `Cough Syrup 100ml ${Date.now()}`,
      barcode: `SYRUP_${Date.now()}`,
      category: 'Syrups',
      unit: 'ml',
      packSize: 1,
      allowFractionalQty: true
    });

    rxProductId = await createProduct({
      name: `Controlled Sedative 10mg ${Date.now()}`,
      barcode: `RX_${Date.now()}`,
      category: 'Controlled',
      unit: 'tablet',
      packSize: 10,
      isRxRequired: true
    });

    multiBatchProductId = await createProduct({
      name: `Paracetamol MultiBatch ${Date.now()}`,
      barcode: `MULTI_${Date.now()}`,
      category: 'Analgesics',
      unit: 'tablet',
      packSize: 1
    });

    await pool.query(
      "UPDATE settings SET value = '{\"rx_requires_pharmacist\": true}'::jsonb WHERE key = 'rx_settings'"
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  // ============================================================================
  // Suite 1: Concurrency, Deadlocks & Idempotency
  // ============================================================================
  describe('Suite 1: Concurrency, Deadlocks & Idempotency', () => {
    it('concurrent sales of last 5 units: exactly one succeeds, one receives 400 INSUFFICIENT_STOCK', async () => {
      const scarceProdId = await createProduct({
        name: `Scarce Product ${Date.now()}`,
        barcode: `SCARCE_${Date.now()}`,
        category: 'Rare',
        unit: 'vial'
      });

      await createGrn([{
        productId: scarceProdId,
        batchNo: `SCARCE-BAT-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 5,
        packCost: 100.00,
        packSize: 1,
        mrp: 150.00
      }]);

      const checkoutBody1 = {
        idempotencyKey: randomUUID(),
        items: [{ productId: scarceProdId, quantity: 5 }],
        payments: [{ type: 'cash', amount: 750.00 }],
        tenderedAmount: 1000.00
      };

      const checkoutBody2 = {
        idempotencyKey: randomUUID(),
        items: [{ productId: scarceProdId, quantity: 5 }],
        payments: [{ type: 'cash', amount: 750.00 }],
        tenderedAmount: 1000.00
      };

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(checkoutBody1)
        }),
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(checkoutBody2)
        })
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 400]);

      const failedRes = res1.status === 400 ? res1 : res2;
      const failData = (await failedRes.json()) as any;
      expect(failData.error).toBe('INSUFFICIENT_STOCK');

      const checkStock = await pool.query(
        'SELECT current_quantity FROM batches WHERE product_id = $1',
        [scarceProdId]
      );
      expect(parseFloat(checkStock.rows[0].current_quantity)).toBe(0.00);
    });

    it('opposite-order multi-product carts succeed without deadlock', async () => {
      const prodA = await createProduct({
        name: `Deadlock Test Prod A ${Date.now()}`,
        barcode: `DLA_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      const prodB = await createProduct({
        name: `Deadlock Test Prod B ${Date.now()}`,
        barcode: `DLB_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });

      await createGrn([
        {
          productId: prodA,
          batchNo: `DLA-B-${Date.now()}`,
          expiryDate: '2028-01-01',
          packsReceived: 20,
          packCost: 10.00,
          packSize: 1,
          mrp: 20.00
        },
        {
          productId: prodB,
          batchNo: `DLB-B-${Date.now()}`,
          expiryDate: '2028-01-01',
          packsReceived: 20,
          packCost: 10.00,
          packSize: 1,
          mrp: 20.00
        }
      ]);

      const cart1 = {
        idempotencyKey: randomUUID(),
        items: [
          { productId: prodA, quantity: 2 },
          { productId: prodB, quantity: 2 }
        ],
        payments: [{ type: 'cash', amount: 80.00 }],
        tenderedAmount: 100.00
      };

      const cart2 = {
        idempotencyKey: randomUUID(),
        items: [
          { productId: prodB, quantity: 2 },
          { productId: prodA, quantity: 2 }
        ],
        payments: [{ type: 'cash', amount: 80.00 }],
        tenderedAmount: 100.00
      };

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(cart1)
        }),
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(cart2)
        })
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
    });

    it('idempotency: sequential duplicate returns original sale with 200 OK and no duplicate rows', async () => {
      const prod = await createProduct({
        name: `Idempotency Test ${Date.now()}`,
        barcode: `IDEM_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `IDEM-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 10.00,
        packSize: 1,
        mrp: 25.00
      }]);

      const idempotencyKey = randomUUID();
      const body = {
        idempotencyKey,
        items: [{ productId: prod, quantity: 2 }],
        payments: [{ type: 'cash', amount: 50.00 }],
        tenderedAmount: 50.00
      };

      const res1 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify(body)
      });
      expect(res1.status).toBe(201);
      const data1 = (await res1.json()) as any;

      const res2 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify(body)
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as any;

      expect(data2.sale.id).toBe(data1.sale.id);
      expect(data2.sale.billNo).toBe(data1.sale.billNo);

      const countCheck = await pool.query(
        'SELECT COUNT(*) FROM sales WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      expect(parseInt(countCheck.rows[0].count, 10)).toBe(1);

      const stockCheck = await pool.query('SELECT current_quantity FROM batches WHERE product_id = $1', [prod]);
      expect(parseFloat(stockCheck.rows[0].current_quantity)).toBe(8.00);
    });

    it('idempotency: missing idempotencyKey returns 400 validation error', async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          items: [{ productId: integerProductId, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('VALIDATION_ERROR');
    });

    it('idempotency: same key with different payload returns 409 IDEMPOTENCY_CONFLICT', async () => {
      const prod = await createProduct({
        name: `Idem Conflict Prod ${Date.now()}`,
        barcode: `IDCONF_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `IDCONF-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 20,
        packCost: 10.00,
        packSize: 1,
        mrp: 20.00
      }]);

      const testKey = randomUUID();

      // First request: quantity = 1
      const res1 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: testKey,
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res1.status).toBe(201);

      // Second request: same key, but different payload (quantity = 2) -> 409
      const res2 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: testKey,
          items: [{ productId: prod, quantity: 2 }],
          payments: [{ type: 'cash', amount: 40.00 }],
          tenderedAmount: 40.00
        })
      });
      expect(res2.status).toBe(409);
      const err = await res2.json();
      expect(err.error).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('idempotency: per-user scope allows different cashiers to use same key independently', async () => {
      const prod = await createProduct({
        name: `Per User Idem Prod ${Date.now()}`,
        barcode: `PUID_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `PUID-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 20,
        packCost: 10.00,
        packSize: 1,
        mrp: 20.00
      }]);

      const sharedKey = randomUUID();

      // Cashier creates sale with sharedKey
      const res1 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: sharedKey,
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res1.status).toBe(201);

      // Pharmacist creates sale with same sharedKey -> succeeds with separate sale!
      const res2 = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          idempotencyKey: sharedKey,
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res2.status).toBe(201);

      const d1 = await res1.json();
      const d2 = await res2.json();
      expect(d1.sale.id).not.toBe(d2.sale.id);
    });

    it('20 concurrent sales generate gap-free INV-YYYYMMDD-#### bill numbers', async () => {
      const bulkProd = await createProduct({
        name: `Bulk Bill Test ${Date.now()}`,
        barcode: `BULK_BILL_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: bulkProd,
        batchNo: `BULK-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 100,
        packCost: 5.00,
        packSize: 1,
        mrp: 10.00
      }]);

      const count = 20;
      const promises = Array.from({ length: count }).map((_, idx) => {
        return fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            items: [{ productId: bulkProd, quantity: 1 }],
            payments: [{ type: 'cash', amount: 10.00 }],
            tenderedAmount: 10.00,
            notes: `Concurrent test ${idx}`
          })
        });
      });

      const responses = await Promise.all(promises);
      for (const r of responses) {
        expect(r.status).toBe(201);
      }

      const results = (await Promise.all(responses.map((r) => r.json()))) as any[];
      const billNumbers = results.map((r) => r.sale.billNo);

      // Verify format INV-YYYYMMDD-####
      for (const b of billNumbers) {
        expect(b).toMatch(/^INV-\d{8}-\d{4}$/);
      }

      // Extract sequence numbers
      const sequenceNumbers = billNumbers
        .map((b: string) => parseInt(b.split('-')[2], 10))
        .sort((a: number, b: number) => a - b);

      // Verify gap-free sequence: every adjacent number is exactly n + 1
      for (let i = 1; i < sequenceNumbers.length; i++) {
        expect(sequenceNumbers[i]).toBe(sequenceNumbers[i - 1] + 1);
      }
    });
  });

  // ============================================================================
  // Suite 2: Pricing, Stock, FEFO & Line Calculations
  // ============================================================================
  describe('Suite 2: Pricing, Stock, FEFO & Line Calculations', () => {
    it('client-supplied prices/costs/totals/batchIds are completely ignored', async () => {
      const prod = await createProduct({
        name: `Tamper Proof Prod ${Date.now()}`,
        barcode: `TP_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `TP-BAT-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 50.00,
        packSize: 1,
        mrp: 100.00
      }]);

      const clientBody: any = {
        idempotencyKey: randomUUID(),
        items: [
          {
            productId: prod,
            quantity: 2,
            mrp: 1.00,
            unitSellingPrice: 1.00,
            unitCostPrice: 0.10,
            batchId: '00000000-0000-0000-0000-000000000000',
            lineTotal: 2.00
          }
        ],
        subtotal: 2.00,
        totalAmount: 2.00,
        payments: [{ type: 'cash', amount: 200.00 }],
        tenderedAmount: 200.00
      };

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify(clientBody)
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sale.subtotal).toBe(200.00);
      expect(data.sale.totalAmount).toBe(200.00);
      expect(data.sale.items[0].unitSellingPrice).toBe(100.00);
    });

    it('rejects checkout when item quantity <= 0', async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: integerProductId, quantity: 0 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('VALIDATION_ERROR');
    });

    it('rejects checkout on inactive product with 400 PRODUCT_INACTIVE', async () => {
      const inactiveProd = await createProduct({
        name: `Inactive Test Prod ${Date.now()}`,
        barcode: `INACT_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await pool.query('UPDATE products SET is_active = false WHERE id = $1', [inactiveProd]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: inactiveProd, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('PRODUCT_INACTIVE');
    });

    it('FEFO: skips expired and zero-quantity batches', async () => {
      const prod = await createProduct({
        name: `FEFO Expiry Skip ${Date.now()}`,
        barcode: `FEFO_EXP_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });

      const expBatchRes = await pool.query(
        `INSERT INTO batches (product_id, supplier_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity, is_active)
         VALUES ($1, $2, 'EXPIRED-BAT', '2020-01-01', 10.00, 20.00, 50, 0, true)
         RETURNING id`,
        [prod, testSupplierId]
      );
      await pool.query(
        `INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id)
         VALUES ($1, 'opening_stock', 50, 'opening', gen_random_uuid())`,
        [expBatchRes.rows[0].id]
      );

      const validBatNo = `VALID-BAT-${Date.now()}`;
      await createGrn([{
        productId: prod,
        batchNo: validBatNo,
        expiryDate: '2028-12-31',
        packsReceived: 10,
        packCost: 10.00,
        packSize: 1,
        mrp: 35.00
      }]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 5 }],
          payments: [{ type: 'cash', amount: 175.00 }],
          tenderedAmount: 200.00
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sale.items[0].batchNo).toBe(validBatNo);

      const checkExp = await pool.query('SELECT current_quantity FROM batches WHERE id = $1', [expBatchRes.rows[0].id]);
      expect(parseFloat(checkExp.rows[0].current_quantity)).toBe(50.00);
    });

    it('3-batch FEFO split across batches with line totals and movements verified', async () => {
      const b1No = `3B-1-${Date.now()}`;
      const b2No = `3B-2-${Date.now()}`;
      const b3No = `3B-3-${Date.now()}`;

      await createGrn([
        {
          productId: multiBatchProductId,
          batchNo: b1No,
          expiryDate: '2027-01-01',
          packsReceived: 3,
          packCost: 5.00,
          packSize: 1,
          mrp: 10.00
        },
        {
          productId: multiBatchProductId,
          batchNo: b2No,
          expiryDate: '2027-02-01',
          packsReceived: 4,
          packCost: 6.00,
          packSize: 1,
          mrp: 12.00
        },
        {
          productId: multiBatchProductId,
          batchNo: b3No,
          expiryDate: '2027-03-01',
          packsReceived: 5,
          packCost: 7.00,
          packSize: 1,
          mrp: 15.00
        }
      ]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: multiBatchProductId, quantity: 10 }],
          payments: [{ type: 'cash', amount: 123.00 }],
          tenderedAmount: 150.00
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sale.totalAmount).toBe(123.00);
      expect(data.sale.items.length).toBe(3);

      expect(data.sale.items[0].batchNo).toBe(b1No);
      expect(data.sale.items[0].quantity).toBe(3);
      expect(data.sale.items[0].lineTotal).toBe(30.00);

      expect(data.sale.items[1].batchNo).toBe(b2No);
      expect(data.sale.items[1].quantity).toBe(4);
      expect(data.sale.items[1].lineTotal).toBe(48.00);

      expect(data.sale.items[2].batchNo).toBe(b3No);
      expect(data.sale.items[2].quantity).toBe(3);
      expect(data.sale.items[2].lineTotal).toBe(45.00);

      const stockRes = await pool.query(
        `SELECT batch_no, current_quantity FROM batches WHERE batch_no IN ($1, $2, $3) ORDER BY expiry_date ASC`,
        [b1No, b2No, b3No]
      );
      expect(parseFloat(stockRes.rows[0].current_quantity)).toBe(0.00);
      expect(parseFloat(stockRes.rows[1].current_quantity)).toBe(0.00);
      expect(parseFloat(stockRes.rows[2].current_quantity)).toBe(2.00);
    });

    it('fractional quantity: rejected on integer product, allowed on fractional product', async () => {
      await createGrn([
        {
          productId: integerProductId,
          batchNo: `INT-B-${Date.now()}`,
          expiryDate: '2028-01-01',
          packsReceived: 10,
          packCost: 10.00,
          packSize: 1,
          mrp: 20.00
        },
        {
          productId: fractionalProductId,
          batchNo: `FRAC-B-${Date.now()}`,
          expiryDate: '2028-01-01',
          packsReceived: 100,
          packCost: 1.00,
          packSize: 1,
          mrp: 2.00
        }
      ]);

      const resInt = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: integerProductId, quantity: 2.5 }],
          payments: [{ type: 'cash', amount: 50.00 }],
          tenderedAmount: 50.00
        })
      });
      expect(resInt.status).toBe(400);
      const dataInt = (await resInt.json()) as any;
      expect(dataInt.error).toBe('FRACTIONAL_QUANTITY_NOT_ALLOWED');

      const resFrac = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: fractionalProductId, quantity: 2.5 }],
          payments: [{ type: 'cash', amount: 5.00 }],
          tenderedAmount: 10.00
        })
      });
      expect(resFrac.status).toBe(201);
      const dataFrac = (await resFrac.json()) as any;
      expect(dataFrac.sale.totalAmount).toBe(5.00);
      expect(dataFrac.sale.items[0].quantity).toBe(2.5);
    });

    it('cash payment accounting: cash tendered 1000 on 800 bill -> paid 800, payments.amount 800, tendered 1000, change 200', async () => {
      const prod = await createProduct({
        name: `Cash Accounting Test ${Date.now()}`,
        barcode: `CASH_ACC_${Date.now()}`,
        category: 'Test',
        unit: 'box'
      });
      await createGrn([{
        productId: prod,
        batchNo: `CACC-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 5,
        packCost: 400.00,
        packSize: 1,
        mrp: 800.00
      }]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 800.00 }],
          tenderedAmount: 1000.00
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      const sale = data.sale;

      expect(sale.totalAmount).toBe(800.00);
      expect(sale.paidAmount).toBe(800.00);
      expect(sale.tenderedAmount).toBe(1000.00);
      expect(sale.changeAmount).toBe(200.00);
      expect(sale.balanceDue).toBe(0.00);
      expect(sale.paymentStatus).toBe('paid');
      expect(sale.payments[0].amount).toBe(800.00);

      const dbCheck = await pool.query(
        'SELECT total_amount, paid_amount, tendered_amount, change_amount, balance_due FROM sales WHERE id = $1',
        [sale.id]
      );
      const row = dbCheck.rows[0];
      expect(parseFloat(row.total_amount)).toBe(800.00);
      expect(parseFloat(row.paid_amount)).toBe(800.00);
      expect(parseFloat(row.tendered_amount)).toBe(1000.00);
      expect(parseFloat(row.change_amount)).toBe(200.00);
      expect(parseFloat(row.balance_due)).toBe(0.00);
    });

    it('card over-tender rejected: non-cash payment cannot have tenderedAmount > paidAmount', async () => {
      const prod = await createProduct({
        name: `Card OverTender Prod ${Date.now()}`,
        barcode: `CARD_OT_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `COT-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 10.00,
        packSize: 1,
        mrp: 50.00
      }]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'card', amount: 50.00 }],
          tenderedAmount: 100.00 // Card cannot tender extra cash!
        })
      });

      expect(res.status).toBe(400);
      const err = await res.json();
      expect(err.error).toBe('CARD_OVER_TENDER_REJECTED');
    });

    it('forced mid-transaction failure rolls back state and does not consume bill sequence', async () => {
      const prod = await createProduct({
        name: `Rollback Test ${Date.now()}`,
        barcode: `RB_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `RB-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 10.00,
        packSize: 1,
        mrp: 50.00
      }]);

      const dateStr = getColomboDateStr();
      const seqKey = `INV-${dateStr}`;
      const prevSeqRes = await pool.query('SELECT current_number FROM bill_sequences WHERE sequence_key = $1', [seqKey]);
      const prevSeq = prevSeqRes.rows.length > 0 ? prevSeqRes.rows[0].current_number : 0;

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2 }],
          payments: [{ type: 'cash', amount: 500.00 }],
          tenderedAmount: 500.00
        })
      });

      expect(res.status).toBe(400);

      const stockCheck = await pool.query('SELECT current_quantity FROM batches WHERE product_id = $1', [prod]);
      expect(parseFloat(stockCheck.rows[0].current_quantity)).toBe(10.00);

      const afterSeqRes = await pool.query('SELECT current_number FROM bill_sequences WHERE sequence_key = $1', [seqKey]);
      const afterSeq = afterSeqRes.rows.length > 0 ? afterSeqRes.rows[0].current_number : 0;
      expect(afterSeq).toBe(prevSeq);
    });
  });

  // ============================================================================
  // Suite 3: Role Restrictions, Data Protection & Rx Security
  // ============================================================================
  describe('Suite 3: Role Restrictions, Data Protection & Rx Security', () => {
    it('discount limits: cashier > 5% rejected (403), pharmacist > 15% rejected (403), owner allowed', async () => {
      const prod = await createProduct({
        name: `Discount Limit Prod ${Date.now()}`,
        barcode: `DISC_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `DISC-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 20,
        packCost: 50.00,
        packSize: 1,
        mrp: 100.00
      }]);

      // Cashier attempts 10% discount on Rs. 200 bill (Rs. 20 discount) -> 403
      const resCashier = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2, discountAmount: 20.00 }],
          payments: [{ type: 'cash', amount: 180.00 }],
          tenderedAmount: 200.00
        })
      });
      expect(resCashier.status).toBe(403);
      const errCashier = (await resCashier.json()) as any;
      expect(errCashier.error).toBe('DISCOUNT_LIMIT_EXCEEDED');

      // Pharmacist attempts 20% discount on Rs. 200 bill (Rs. 40 discount) -> 403
      const resPharm = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2, discountAmount: 40.00 }],
          payments: [{ type: 'cash', amount: 160.00 }],
          tenderedAmount: 200.00
        })
      });
      expect(resPharm.status).toBe(403);
      const errPharm = (await resPharm.json()) as any;
      expect(errPharm.error).toBe('DISCOUNT_LIMIT_EXCEEDED');

      // Owner attempts 20% discount on Rs. 200 bill -> Allowed (201)
      const resOwner = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2, discountAmount: 40.00 }],
          payments: [{ type: 'cash', amount: 160.00 }],
          tenderedAmount: 200.00
        })
      });
      expect(resOwner.status).toBe(201);
      const dataOwner = (await resOwner.json()) as any;
      expect(dataOwner.sale.discountAmount).toBe(40.00);
      expect(dataOwner.sale.totalAmount).toBe(160.00);
    });

    it('combined line + bill discount limit: cashier rejected when line + bill discount > 5%', async () => {
      const prod = await createProduct({
        name: `Combined Disc Prod ${Date.now()}`,
        barcode: `COMB_DISC_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `CDISC-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 20,
        packCost: 50.00,
        packSize: 1,
        mrp: 100.00
      }]);

      // Total 200 bill: item discount 6 (3%), bill discount 6 (3%) -> total 12 (6%) > cashier 5% limit
      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2, discountAmount: 6.00 }],
          billDiscount: 6.00,
          payments: [{ type: 'cash', amount: 188.00 }],
          tenderedAmount: 200.00
        })
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('DISCOUNT_LIMIT_EXCEEDED');
    });

    it('Rx enforcement: missing doctor/patient rejected (400), cashier rejected (403), pharmacist succeeds', async () => {
      await createGrn([{
        productId: rxProductId,
        batchNo: `RX-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 20.00,
        packSize: 1,
        mrp: 50.00
      }]);

      // Missing doctor/patient names
      const resMissingRx = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: rxProductId, quantity: 1 }],
          payments: [{ type: 'cash', amount: 50.00 }],
          tenderedAmount: 50.00
        })
      });
      expect(resMissingRx.status).toBe(400);
      const errMissingRx = (await resMissingRx.json()) as any;
      expect(errMissingRx.error).toBe('RX_DETAILS_REQUIRED');

      // Cashier attempting to dispense Rx items
      const resCashierRx = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: rxProductId, quantity: 1 }],
          payments: [{ type: 'cash', amount: 50.00 }],
          tenderedAmount: 50.00,
          doctorName: 'Dr. Fernando',
          patientName: 'Sunil Silva'
        })
      });
      expect(resCashierRx.status).toBe(403);
      const errCashierRx = (await resCashierRx.json()) as any;
      expect(errCashierRx.error).toBe('RX_DISPENSING_RESTRICTED');

      // Pharmacist dispensing Rx items -> 201
      const resPharmRx = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: rxProductId, quantity: 1 }],
          payments: [{ type: 'cash', amount: 50.00 }],
          tenderedAmount: 50.00,
          doctorName: 'Dr. Fernando',
          patientName: 'Sunil Silva'
        })
      });
      expect(resPharmRx.status).toBe(201);
      const dataPharmRx = (await resPharmRx.json()) as any;
      expect(dataPharmRx.sale.hasRxItems).toBe(true);
      expect(dataPharmRx.sale.doctorName).toBe('Dr. Fernando');
    });

    it('rx_requires_pharmacist toggle: when false cashier can dispense Rx, when true cashier is blocked', async () => {
      try {
        // Toggle setting to false
        await pool.query(
          "UPDATE settings SET value = '{\"rx_requires_pharmacist\": false}'::jsonb WHERE key = 'rx_settings'"
        );

        // Cashier checkout now succeeds
        const resAllowed = await fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            items: [{ productId: rxProductId, quantity: 1 }],
            payments: [{ type: 'cash', amount: 50.00 }],
            tenderedAmount: 50.00,
            doctorName: 'Dr. Perera',
            patientName: 'Kamal Silva'
          })
        });
        expect(resAllowed.status).toBe(201);
      } finally {
        // Toggle setting back to true
        await pool.query(
          "UPDATE settings SET value = '{\"rx_requires_pharmacist\": true}'::jsonb WHERE key = 'rx_settings'"
        );
      }

      // Cashier checkout is blocked again
      const resBlocked = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: rxProductId, quantity: 1 }],
          payments: [{ type: 'cash', amount: 50.00 }],
          tenderedAmount: 50.00,
          doctorName: 'Dr. Perera',
          patientName: 'Kamal Silva'
        })
      });
      expect(resBlocked.status).toBe(403);
    });

    it('cashier response isolation: response contains zero cost/profit fields and createdAt is ISO string', async () => {
      const prod = await createProduct({
        name: `Masking Test Prod ${Date.now()}`,
        barcode: `MASK_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `MASK-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 45.00,
        packSize: 1,
        mrp: 90.00
      }]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 90.00 }],
          tenderedAmount: 100.00
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      const sale = data.sale;

      expect(new Date(sale.createdAt).toISOString()).toBe(sale.createdAt);

      expect(sale.costPrice).toBeUndefined();
      expect(sale.unitCostPrice).toBeUndefined();
      expect(sale.packCost).toBeUndefined();
      expect(sale.margin).toBeUndefined();
      expect(sale.profit).toBeUndefined();

      for (const item of sale.items) {
        expect(item.unitCostPrice).toBeUndefined();
        expect(item.costPrice).toBeUndefined();
        expect(item.packCost).toBeUndefined();
      }

      const getRes = await fetch(`${baseUrl}/api/v1/sales/${sale.id}`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(getRes.status).toBe(200);
      const getData = (await getRes.json()) as any;
      for (const item of getData.sale.items) {
        expect(item.unitCostPrice).toBeUndefined();
      }
    });

    it('cashier sales list is restricted to own sales and today only', async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      const userRes = await pool.query("SELECT id FROM users WHERE username = 'cashier'");
      const cashierId = userRes.rows[0].id;

      for (const sale of data.sales) {
        expect(sale.cashierId).toBe(cashierId);
        const saleDate = getColomboDateFormatted(new Date(sale.createdAt));
        const today = getColomboDateFormatted(new Date());
        expect(saleDate).toBe(today);
      }
    });
  });

  // ============================================================================
  // Suite 4: Customer Credit & Credit Race
  // ============================================================================
  describe('Suite 4: Customer Credit & Credit Race', () => {
    it('walk-in credit sale rejected: outstanding balance requires customer', async () => {
      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: integerProductId, quantity: 1 }],
          payments: [], // 0 payment = credit sale
          tenderedAmount: 0.00
          // No customerId provided
        })
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('CUSTOMER_REQUIRED_FOR_CREDIT');
    });

    it('credit sale: updates customer credit_balance and appends customer_ledger entry', async () => {
      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          name: `Credit Customer ${Date.now()}`,
          phone: `071${Math.floor(1000000 + Math.random() * 9000000)}`,
          creditLimit: 5000.00
        })
      });
      const cust = (await custRes.json()) as any;
      const custId = cust.customer.id;

      const prod = await createProduct({
        name: `Credit Prod ${Date.now()}`,
        barcode: `CRED_${Date.now()}`,
        category: 'Test',
        unit: 'box'
      });
      await createGrn([{
        productId: prod,
        batchNo: `CRED-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 500.00,
        packSize: 1,
        mrp: 1000.00
      }]);

      const res = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          customerId: custId,
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 400.00 }],
          tenderedAmount: 400.00
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.sale.balanceDue).toBe(600.00);
      expect(data.sale.paymentStatus).toBe('partial');

      const checkCust = await pool.query('SELECT credit_balance FROM customers WHERE id = $1', [custId]);
      expect(parseFloat(checkCust.rows[0].credit_balance)).toBe(600.00);

      const ledgerRes = await pool.query(
        `SELECT entry_type, amount, balance_after, ref_type, ref_id 
         FROM customer_ledger WHERE customer_id = $1`,
        [custId]
      );
      expect(ledgerRes.rows.length).toBe(1);
      expect(ledgerRes.rows[0].entry_type).toBe('credit_sale');
      expect(parseFloat(ledgerRes.rows[0].amount)).toBe(600.00);
      expect(parseFloat(ledgerRes.rows[0].balance_after)).toBe(600.00);
      expect(ledgerRes.rows[0].ref_id).toBe(data.sale.id);
    });

    it('credit limit race: two concurrent credit sales of 600 on limit 1000 -> one succeeds, one rejected (400)', async () => {
      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          name: `Race Customer ${Date.now()}`,
          phone: `072${Math.floor(1000000 + Math.random() * 9000000)}`,
          creditLimit: 1000.00
        })
      });
      const cust = (await custRes.json()) as any;
      const custId = cust.customer.id;

      const prod = await createProduct({
        name: `Race Prod ${Date.now()}`,
        barcode: `RACE_${Date.now()}`,
        category: 'Test',
        unit: 'box'
      });
      await createGrn([{
        productId: prod,
        batchNo: `RACE-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 300.00,
        packSize: 1,
        mrp: 600.00
      }]);

      const saleBody1 = {
        idempotencyKey: randomUUID(),
        customerId: custId,
        items: [{ productId: prod, quantity: 1 }],
        payments: [],
        tenderedAmount: 0.00
      };
      const saleBody2 = {
        idempotencyKey: randomUUID(),
        customerId: custId,
        items: [{ productId: prod, quantity: 1 }],
        payments: [],
        tenderedAmount: 0.00
      };

      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(saleBody1)
        }),
        fetch(`${baseUrl}/api/v1/sales`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
          body: JSON.stringify(saleBody2)
        })
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 400]);

      const failedRes = res1.status === 400 ? res1 : res2;
      const err = (await failedRes.json()) as any;
      expect(err.error).toBe('CREDIT_LIMIT_EXCEEDED');

      const finalCust = await pool.query('SELECT credit_balance FROM customers WHERE id = $1', [custId]);
      expect(parseFloat(finalCust.rows[0].credit_balance)).toBe(600.00);
    });
  });

  // ============================================================================
  // Suite 5: Sales Void, Stock Reconcile & DB Immutability Trigger
  // ============================================================================
  describe('Suite 5: Sales Void, Stock Reconcile & DB Immutability Trigger', () => {
    it('void restores stock into original batches, reverses credit, and reconciles stock in SQL', async () => {
      const custRes = await fetch(`${baseUrl}/api/v1/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          name: `Void Test Cust ${Date.now()}`,
          phone: `075${Math.floor(1000000 + Math.random() * 9000000)}`,
          creditLimit: 2000.00
        })
      });
      const custId = (await custRes.json()).customer.id;

      const prod = await createProduct({
        name: `Void Stock Prod ${Date.now()}`,
        barcode: `VSP_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      const grnData = await createGrn([{
        productId: prod,
        batchNo: `VSP-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 10,
        packCost: 50.00,
        packSize: 1,
        mrp: 100.00
      }]);
      const targetBatchId = grnData.items[0].batchId;

      const saleRes = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          customerId: custId,
          items: [{ productId: prod, quantity: 4 }],
          payments: [],
          tenderedAmount: 0.00
        })
      });
      expect(saleRes.status).toBe(201);
      const saleId = (await saleRes.json()).sale.id;

      const stock1 = await pool.query('SELECT current_quantity FROM batches WHERE product_id = $1', [prod]);
      expect(parseFloat(stock1.rows[0].current_quantity)).toBe(6.00);

      // Void sale by pharmacist
      const voidRes = await fetch(`${baseUrl}/api/v1/sales/${saleId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({ reason: 'Patient returned before leaving store' })
      });
      expect(voidRes.status).toBe(200);
      const voidData = (await voidRes.json()) as any;
      expect(voidData.sale.status).toBe('voided');
      expect(voidData.sale.voidReason).toBe('Patient returned before leaving store');

      // Stock restored to 10.00
      const stock2 = await pool.query('SELECT current_quantity FROM batches WHERE product_id = $1', [prod]);
      expect(parseFloat(stock2.rows[0].current_quantity)).toBe(10.00);

      // Customer balance reversed to 0.00
      const custBal2 = await pool.query('SELECT credit_balance FROM customers WHERE id = $1', [custId]);
      expect(parseFloat(custBal2.rows[0].credit_balance)).toBe(0.00);

      // Reconcile batch stock strictly in SQL: SUM(qty_change) = current_quantity
      const reconResult = await reconcileBatchStock(pool, targetBatchId);
      expect(reconResult.reconciled).toBe(true);
      expect(reconResult.currentQuantity).toBe('10.00');
      expect(reconResult.movementSum).toBe('10.00');

      // Verify GET /api/v1/stock/reconcile/:batchId endpoint
      const reconRes = await fetch(`${baseUrl}/api/v1/stock/reconcile/${targetBatchId}`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(reconRes.status).toBe(200);
      const reconData = await reconRes.json();
      expect(reconData.isReconciled).toBe(true);
      expect(reconData.currentQuantity).toBe('10.00');
      expect(reconData.movementsSum).toBe('10.00');
    });

    it('cashier attempting to void sale is rejected with 403 Forbidden', async () => {
      const sRes = await pool.query("SELECT id FROM sales WHERE status = 'completed' LIMIT 1");
      const saleId = sRes.rows[0].id;

      const voidRes = await fetch(`${baseUrl}/api/v1/sales/${saleId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({ reason: 'Cashier attempt' })
      });
      expect(voidRes.status).toBe(403);
    });

    it('void is blocked if sales returns exist against the sale', async () => {
      const prod = await createProduct({
        name: `Return Block Prod ${Date.now()}`,
        barcode: `RET_BLK_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `RET-BLK-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 5,
        packCost: 10.00,
        packSize: 1,
        mrp: 20.00
      }]);

      const saleRes = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 2 }],
          payments: [{ type: 'cash', amount: 40.00 }],
          tenderedAmount: 40.00
        })
      });
      const saleId = (await saleRes.json()).sale.id;

      const userRes = await pool.query("SELECT id FROM users WHERE username = 'admin'");
      const adminId = userRes.rows[0].id;

      await pool.query(
        `INSERT INTO sales_returns (original_sale_id, return_no, refund_amount, refund_payment_type, reason, processed_by)
         VALUES ($1, $2, 20.00, 'cash', 'Damaged tablet', $3)`,
        [saleId, `RET-${Date.now()}`, adminId]
      );

      const voidRes = await fetch(`${baseUrl}/api/v1/sales/${saleId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ reason: 'Try to void sale with return' })
      });
      expect(voidRes.status).toBe(409);
      const err = (await voidRes.json()) as any;
      expect(err.error).toBe('VOID_BLOCKED_HAS_RETURNS');
    });

    it('direct UPDATE of sales table outside void fields is blocked by DB trigger', async () => {
      const sRes = await pool.query("SELECT id FROM sales WHERE status = 'completed' LIMIT 1");
      const saleId = sRes.rows[0].id;

      let threw = false;
      try {
        await pool.query('UPDATE sales SET subtotal = 1.00 WHERE id = $1', [saleId]);
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Direct update of sales records is prohibited');
      }
      expect(threw).toBe(true);

      const vRes = await pool.query("SELECT id FROM sales WHERE status = 'voided' LIMIT 1");
      if (vRes.rows.length > 0) {
        let threwVoid = false;
        try {
          await pool.query("UPDATE sales SET notes = 'tampered' WHERE id = $1", [vRes.rows[0].id]);
        } catch (err: any) {
          threwVoid = true;
          expect(err.message).toContain('Cannot modify a voided sale');
        }
        expect(threwVoid).toBe(true);
      }
    });
  });

  // ============================================================================
  // Suite 6: Receipt Generation, Timezone 00:30 & Reprint Audit
  // ============================================================================
  describe('Suite 6: Receipt Generation, Timezone 00:30 & Reprint Audit', () => {
    it('proves connection timezone is Asia/Colombo and date at 00:30 Colombo corresponds to next day', async () => {
      // Show connection timezone from pool
      const tzRes = await pool.query('SHOW timezone');
      expect(tzRes.rows[0].TimeZone).toBe('Asia/Colombo');

      // 19:00 UTC on 2026-11-15 is 00:30 AM on 2026-11-16 in Asia/Colombo (UTC+05:30)
      const lateUtc = new Date('2026-11-15T19:00:00.000Z');
      const colomboDateStr = getColomboDateStr(lateUtc);
      expect(colomboDateStr).toBe('20261116');

      const colomboFormatted = getColomboDateFormatted(lateUtc);
      expect(colomboFormatted).toBe('2026-11-16');

      // In Postgres with Asia/Colombo session, timestamptz at 19:00 UTC evaluates to day 16
      const pgTzRes = await pool.query(
        "SELECT ('2026-11-15 19:00:00+00'::timestamptz)::date::text as colombo_date"
      );
      expect(pgTzRes.rows[0].colombo_date).toBe('2026-11-16');
    });

    it('receipt endpoint: initial generation is not duplicate, second generation marks isDuplicate and logs audit', async () => {
      const prod = await createProduct({
        name: `Receipt Test Prod ${Date.now()}`,
        barcode: `RCPT_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `RCPT-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 5,
        packCost: 10.00,
        packSize: 1,
        mrp: 20.00
      }]);
      const saleRes = await fetch(`${baseUrl}/api/v1/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          items: [{ productId: prod, quantity: 1 }],
          payments: [{ type: 'cash', amount: 20.00 }],
          tenderedAmount: 20.00
        })
      });
      expect(saleRes.status).toBe(201);
      const saleData = (await saleRes.json()) as any;
      const saleId = saleData.sale.id;
      const billNo = saleData.sale.billNo;

      expect(billNo).toMatch(/^INV-\d{8}-\d{4}$/);

      // 1. First fetch: original print
      const res1 = await fetch(`${baseUrl}/api/v1/sales/${saleId}/receipt`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res1.status).toBe(200);
      const data1 = (await res1.json()) as any;
      expect(data1.isDuplicate).toBe(false);
      expect(data1.reprintCount).toBe(0);
      expect(data1.receiptText).not.toContain('*** DUPLICATE / REPRINT ***');
      expect(data1.receiptText).toContain('CITY HEALTH PHARMACY');
      expect(data1.receiptText).toContain(billNo);

      // 2. Second fetch: duplicate reprint
      const res2 = await fetch(`${baseUrl}/api/v1/sales/${saleId}/receipt`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as any;
      expect(data2.isDuplicate).toBe(true);
      expect(data2.reprintCount).toBe(1);
      expect(data2.receiptText).toContain('*** DUPLICATE / REPRINT ***');
    });
  });

  // ============================================================================
  // Suite 7: Hold Bills Lifecycle
  // ============================================================================
  describe('Suite 7: Hold Bills Lifecycle', () => {
    it('creates held bill without reserving stock, lists, resumes with live pricing, and discards', async () => {
      const prod = await createProduct({
        name: `Hold Bill Prod ${Date.now()}`,
        barcode: `HB_${Date.now()}`,
        category: 'Test',
        unit: 'tab'
      });
      await createGrn([{
        productId: prod,
        batchNo: `HB-B-${Date.now()}`,
        expiryDate: '2028-01-01',
        packsReceived: 20,
        packCost: 20.00,
        packSize: 1,
        mrp: 40.00
      }]);

      // 1. Create Hold Bill
      const createRes = await fetch(`${baseUrl}/api/v1/hold-bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          customerName: 'Walk-in Customer Waiting',
          items: [{ productId: prod, quantity: 5 }]
        })
      });
      expect(createRes.status).toBe(201);
      const createData = (await createRes.json()) as any;
      const holdId = createData.holdBill.id;
      expect(createData.holdBill.status).toBe('held');
      expect(createData.holdBill.items[0].quantity).toBe(5);

      // Verify stock was NOT deducted (still 20)
      const stockCheck = await pool.query('SELECT current_quantity FROM batches WHERE product_id = $1', [prod]);
      expect(parseFloat(stockCheck.rows[0].current_quantity)).toBe(20.00);

      // 2. List Hold Bills
      const listRes = await fetch(`${baseUrl}/api/v1/hold-bills`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as any;
      const found = listData.holdBills.find((h: any) => h.id === holdId);
      expect(found).toBeDefined();
      expect(found.status).toBe('held');

      // 3. Resume Hold Bill
      const resumeRes = await fetch(`${baseUrl}/api/v1/hold-bills/${holdId}/resume`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(resumeRes.status).toBe(200);
      const resumeData = (await resumeRes.json()) as any;
      expect(resumeData.holdBill.status).toBe('resumed');
      expect(resumeData.holdBill.allStockAvailable).toBe(true);
      expect(resumeData.holdBill.items[0].currentMrp).toBe(40.00);
      expect(resumeData.holdBill.items[0].availableStock).toBe(20.00);

      // 4. Create another hold bill to test discard
      const create2 = await fetch(`${baseUrl}/api/v1/hold-bills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cashierToken}` },
        body: JSON.stringify({
          customerName: 'Customer Abandoned',
          items: [{ productId: prod, quantity: 2 }]
        })
      });
      const holdId2 = (await create2.json()).holdBill.id;

      const discardRes = await fetch(`${baseUrl}/api/v1/hold-bills/${holdId2}/discard`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(discardRes.status).toBe(200);

      const checkHb = await pool.query('SELECT status FROM hold_bills WHERE id = $1', [holdId2]);
      expect(checkHb.rows[0].status).toBe('discarded');
    });
  });

  // ============================================================================
  // Suite 8: Audit Service Hardening Invariants
  // ============================================================================
  describe('Suite 8: Audit Service Hardening Invariants', () => {
    it('normalizes keys, redacts sensitive credential keys, and respects depth limits & BigInt', () => {
      const dirtyObj = {
        User_Password: 'secretPassword123',
        'auth-token': 'jwt.token.string',
        apiKey: 'my-api-key',
        secret_key: 'topsecret',
        Authorization_Header: 'Bearer xyz',
        session_cookie: 'sess_123',
        regularNumber: 100,
        bigNumber: BigInt('9007199254740993'),
        nested: {
          deep_password: 'deepSecret',
          normalKey: 'visible'
        }
      };

      const sanitized = sanitizeForAudit(dirtyObj);
      expect(sanitized.User_Password).toBe('[REDACTED]');
      expect(sanitized['auth-token']).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.secret_key).toBe('[REDACTED]');
      expect(sanitized.Authorization_Header).toBe('[REDACTED]');
      expect(sanitized.session_cookie).toBe('[REDACTED]');
      expect(sanitized.regularNumber).toBe(100);
      expect(sanitized.bigNumber).toBe('9007199254740993');
      expect(sanitized.nested.deep_password).toBe('[REDACTED]');
      expect(sanitized.nested.normalKey).toBe('visible');

      // Depth limit test
      let deep: any = { value: 'leaf' };
      for (let i = 0; i < 15; i++) {
        deep = { next: deep };
      }
      const depthSanitized = sanitizeForAudit(deep, 0, 5);
      expect(JSON.stringify(depthSanitized)).toContain('[MAX_DEPTH_EXCEEDED]');
    });

    it('validates IP addresses: accepts IPv4 and IPv6, rejects invalid strings', () => {
      expect(validateIpAddress('192.168.1.1')).toBe('192.168.1.1');
      expect(validateIpAddress('10.0.0.1')).toBe('10.0.0.1');
      expect(validateIpAddress('::1')).toBe('::1');
      expect(validateIpAddress('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
      expect(validateIpAddress('not-an-ip')).toBeNull();
      expect(validateIpAddress('999.999.999.999')).toBeNull();
      expect(validateIpAddress(null)).toBeNull();
      expect(validateIpAddress(undefined)).toBeNull();
    });

    it('enforces mandatory transaction client on money mutation audits', async () => {
      let threw = false;
      try {
        await logAudit({
          action: 'SALE_CREATED',
          entity: 'SALE',
          entityId: randomUUID(),
          afterState: { amount: 100 }
          // client is intentionally omitted!
        });
      } catch (err: any) {
        threw = true;
        expect(err.message).toContain('Database client (PoolClient) is mandatory for transactional money audit log: SALE_CREATED');
      }
      expect(threw).toBe(true);
    });
  });
});
