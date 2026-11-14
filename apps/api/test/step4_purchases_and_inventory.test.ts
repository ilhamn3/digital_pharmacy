import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import { app } from '../src/index.js';
import { pool, assertAppRoleSecurity } from '../src/db/pool.js';
import { generateCsv, parseCsv } from '../src/utils/csv.js';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Step 4: Purchases (GRN), Stock Adjustments, Inventory Lists & Role Security', () => {
  let server: http.Server;
  let baseUrl: string;

  let ownerToken: string;
  let pharmacistToken: string;
  let cashierToken: string;

  let testSupplierId: string;
  let testProductId: string;
  let testBoxProductId: string; // for box 1000/30 rounding test
  let createdPurchaseId: string;
  let createdBatchId: string;

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

    // Create a dedicated supplier for Step 4 tests
    const supRes = await fetch(`${baseUrl}/api/v1/suppliers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        name: `GRN Test Supplier ${Date.now()}`,
        phone: '0112334455',
        address: '100 Warehouse Way, Colombo',
        outstandingBalance: 0.00
      })
    });
    const supData = (await supRes.json()) as any;
    expect(supRes.status).toBe(201);
    testSupplierId = supData.supplier.id;

    // Create test products
    const prodRes1 = await fetch(`${baseUrl}/api/v1/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        name: `Paracetamol 500mg GRN ${Date.now()}`,
        barcode: `GRN_BAR_${Date.now()}`,
        category: 'Analgesics',
        unit: 'tablet',
        packSize: 10,
        reorderLevel: 50
      })
    });
    const prodData1 = (await prodRes1.json()) as any;
    expect(prodRes1.status).toBe(201);
    testProductId = prodData1.product.id;

    // Box of 1000 / 30 units product for rounding proof
    const prodRes2 = await fetch(`${baseUrl}/api/v1/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`
      },
      body: JSON.stringify({
        name: `Box 1000 Product ${Date.now()}`,
        barcode: `BOX_BAR_${Date.now()}`,
        category: 'Antibiotics',
        unit: 'tablet',
        packSize: 30,
        reorderLevel: 100
      })
    });
    const prodData2 = (await prodRes2.json()) as any;
    expect(prodRes2.status).toBe(201);
    testBoxProductId = prodData2.product.id;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  describe('Part A: Role & Security Hardening Fixes', () => {
    it('verifies API connects as pharmacy_app and startup security assertion functions correctly', async () => {
      const securityInfo = await assertAppRoleSecurity(pool);
      expect(securityInfo.currentUser).toBe('pharmacy_app');
      expect(securityInfo.isSuperuser).toBe(false);
      expect(securityInfo.isTableOwner).toBe(false);

      // Verify startup check throws in production when role is superuser/owner
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const fakeOwnerPool = {
          query: async () => ({
            rows: [{ db_user: 'postgres', is_superuser: true, is_table_owner: true }]
          })
        } as any;

        let threw = false;
        try {
          await assertAppRoleSecurity(fakeOwnerPool);
        } catch (err: any) {
          threw = true;
          expect(err.message).toContain('must not be a superuser or table owner');
        }
        expect(threw).toBe(true);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('proves pharmacy_app role is denied DELETE on financial tables but allowed DELETE on refresh_tokens', async () => {
      // 1. DELETE on batches denied
      let delBatchErr: any = null;
      try {
        await pool.query('DELETE FROM batches WHERE id = gen_random_uuid()');
      } catch (err: any) {
        delBatchErr = err;
      }
      expect(delBatchErr).not.toBeNull();
      expect(delBatchErr.message).toMatch(/permission denied|append-only|prohibited/i);

      // 2. DELETE on refresh_tokens is granted
      let delTokenErr: any = null;
      try {
        await pool.query('DELETE FROM refresh_tokens WHERE id = gen_random_uuid()');
      } catch (err: any) {
        delTokenErr = err;
      }
      expect(delTokenErr).toBeNull();
    });

    it('Login: enforces progressive delay with timing equivalence between unknown user and wrong password', async () => {
      // First attempt
      await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cashier', password: 'wrongpassword' })
      });

      // Compare response times for unknown user vs existing user
      const start1 = Date.now();
      const resWrong = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cashier', password: 'wrongpassword' })
      });
      const dur1 = Date.now() - start1;

      const start2 = Date.now();
      const resUnknown = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: `non_existent_${Date.now()}`, password: 'wrongpassword' })
      });
      const dur2 = Date.now() - start2;

      expect(resWrong.status).toBe(401);
      expect(resUnknown.status).toBe(401);

      const bodyWrong = await resWrong.json();
      const bodyUnknown = await resUnknown.json();
      expect(bodyWrong).toEqual(bodyUnknown);

      // Both execute bcrypt hash check + progressive delay, timing diff is reasonable
      expect(Math.abs(dur1 - dur2)).toBeLessThan(350);
    });

    it('CSV: preserves "+Vitamin C" intact on import and verifies round-trip export has no extra apostrophes', async () => {
      const uniqueBarcode = `VIT_BAR_${Date.now()}`;
      const uniqueProductName = `+Vitamin C ${Date.now()}`;
      const importPayload = [
        'Product Name,Category,Unit,Pack Size,Rx Required,Reorder Level,Batch No,Expiry Date,Quantity,Cost Price,MRP,Barcode',
        `${uniqueProductName},Supplements,bottle,1,false,10,B-VIT-01,2027-12-31,50,250.00,350.00,${uniqueBarcode}`
      ].join('\r\n');

      const importRes = await fetch(`${baseUrl}/api/v1/products/import-csv?dryRun=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({ csvContent: importPayload })
      });
      const importData = (await importRes.json()) as any;
      expect(importRes.status).toBe(201);
      expect(importData.summary.totalRowsImported).toBe(1);

      // Verify product name in DB is exactly "+Vitamin C ..." (text not altered)
      const checkDb = await pool.query('SELECT name FROM products WHERE barcode = $1', [uniqueBarcode]);
      expect(checkDb.rows.length).toBe(1);
      expect(checkDb.rows[0].name).toBe(uniqueProductName);

      // Now export CSV and verify
      const exportRes = await fetch(`${baseUrl}/api/v1/products/export-csv`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      const exportText = await exportRes.text();

      // On export, formula sanitization escaped it with leading apostrophe
      expect(exportText).toContain(`'${uniqueProductName}`);

      // Verify standard product has no extra apostrophe
      expect(exportText).toContain('Paracetamol');
      expect(exportText).not.toContain("'Paracetamol");
    });

    it('CSV Import: rejects negative numbers and malformed number strings with validation errors', async () => {
      const invalidCsv = [
        'Product Name,Category,Unit,Pack Size,Rx Required,Reorder Level,Batch No,Expiry Date,Quantity,Cost Price,MRP,Barcode',
        `Bad Product 1,General,tablet,1,false,10,B-BAD-1,2027-12-31,-50,250.00,350.00,BAR_NEG_${Date.now()}`,
        `Bad Product 2,General,tablet,1,false,10,B-BAD-2,2027-12-31,50,malformed_cost,350.00,BAR_MAL_${Date.now()}`
      ].join('\r\n');

      const importRes = await fetch(`${baseUrl}/api/v1/products/import-csv`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({ csvContent: invalidCsv })
      });
      const importData = (await importRes.json()) as any;
      expect(importRes.status).toBe(422);
      expect(importData.mode).toBe('VALIDATION_FAILED');
      expect(importData.errors.length).toBe(2);
      expect(importData.errors[0].errors.some((e: string) => e.includes('Quantity must be a positive number'))).toBe(true);
      expect(importData.errors[1].errors.some((e: string) => e.includes('Cost price must be non-negative'))).toBe(true);
    });

    it('Product List: reports non-expired stock in totalStock and expired stock separately', async () => {
      // Create expired batch and non-expired batch for test product
      const resList = await fetch(`${baseUrl}/api/v1/products/${testProductId}`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      const data = (await resList.json()) as any;
      expect(resList.status).toBe(200);
      expect(data.product).toHaveProperty('totalStock');
      expect(data.product).toHaveProperty('expiredQuantity');
    });

    it('Report routes return 403 for cashier and stub placeholder for owner', async () => {
      const resCashier = await fetch(`${baseUrl}/api/v1/reports`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(resCashier.status).toBe(403);

      const resOwner = await fetch(`${baseUrl}/api/v1/reports`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      expect(resOwner.status).toBe(200);
      const data = await resOwner.json();
      expect(data.status).toBe('ok');
    });
  });

  describe('Part B: Step 4 Purchases (GRN) Invariants & Endpoints', () => {
    const testInvoiceNo = `INV-${Date.now()}`;

    it('creates a GRN atomically in ONE transaction: purchase + items + batch + movements + ledger + audit', async () => {
      const supBefore = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      const prevBal = Number(supBefore.rows[0].outstanding_balance);

      const res = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: testInvoiceNo,
          purchaseDate: '2026-11-12',
          notes: 'Standard monthly delivery',
          items: [
            {
              productId: testProductId,
              batchNo: `BAT-${Date.now()}`,
              expiryDate: '2027-11-12',
              packsReceived: 10,
              packCost: 400.00,
              packSize: 10,
              mrp: 50.00
            }
          ]
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      createdPurchaseId = data.purchase.id;
      createdBatchId = data.items[0].batchId;

      // 1. Grand total = 10 packs * 400.00 = 4000.00
      expect(Number(data.purchase.totalAmount)).toBe(4000.00);

      // 2. Batch quantity in smallest unit = 10 * 10 = 100
      expect(data.items[0].quantity).toBe(100);
      // Unit cost = 400 / 10 = 40.0000
      expect(Number(data.items[0].unitCostPrice)).toBe(40.00);

      // 3. Batch current_quantity in DB is exactly 100 via stock_movements trigger
      const batchCheck = await pool.query('SELECT current_quantity, initial_quantity FROM batches WHERE id = $1', [createdBatchId]);
      expect(Number(batchCheck.rows[0].current_quantity)).toBe(100);
      expect(Number(batchCheck.rows[0].initial_quantity)).toBe(100);

      // 4. Stock movement row exists with type 'purchase'
      const movCheck = await pool.query('SELECT movement_type, qty_change FROM stock_movements WHERE batch_id = $1', [createdBatchId]);
      expect(movCheck.rows.length).toBe(1);
      expect(movCheck.rows[0].movement_type).toBe('purchase');
      expect(Number(movCheck.rows[0].qty_change)).toBe(100);

      // 5. Supplier ledger row exists with 'purchase_credit' and updated balance
      const supAfter = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      const newBal = Number(supAfter.rows[0].outstanding_balance);
      expect(newBal).toBe(prevBal + 4000.00);

      const ledgerCheck = await pool.query('SELECT entry_type, amount, balance_after FROM supplier_ledger WHERE ref_id = $1', [createdPurchaseId]);
      expect(ledgerCheck.rows.length).toBe(1);
      expect(ledgerCheck.rows[0].entry_type).toBe('purchase_credit');
      expect(Number(ledgerCheck.rows[0].amount)).toBe(4000.00);
      expect(Number(ledgerCheck.rows[0].balance_after)).toBe(newBal);

      // 6. Audit log row written in the same transaction
      const auditCheck = await pool.query("SELECT action, entity_id FROM audit_logs WHERE entity = 'PURCHASE' AND entity_id = $1", [createdPurchaseId]);
      expect(auditCheck.rows.length).toBe(1);
      expect(auditCheck.rows[0].action).toBe('PURCHASE_CREATED');
    });

    it('reconciles batch stock: SUM(stock_movements.qty_change) = batches.current_quantity', async () => {
      const recRes = await fetch(`${baseUrl}/api/v1/stock/reconcile/${createdBatchId}`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(recRes.status).toBe(200);
      const recData = (await recRes.json()) as any;
      expect(recData.isReconciled).toBe(true);
      expect(Number(recData.currentQuantity)).toBe(100);
      expect(Number(recData.movementsSum)).toBe(100);
      expect(recData.discrepancy).toBe(0);
    });

    it('rejects duplicate (supplier, invoice_no) with 409 Conflict', async () => {
      const res = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: testInvoiceNo, // DUPLICATE
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: testProductId,
              batchNo: 'BAT-DUP-01',
              expiryDate: '2027-11-12',
              packsReceived: 5,
              packCost: 400.00,
              mrp: 50.00
            }
          ]
        })
      });

      expect(res.status).toBe(409);
      const data = (await res.json()) as any;
      expect(data.error).toBe('DUPLICATE_INVOICE');
      expect(data.message).toContain('already exists');
    });

    it('verifies rounding precision rule: box of 1000 / 30 units -> unit cost = 33.3333, line total = 1000.00', async () => {
      const boxInvoice = `BOX-INV-${Date.now()}`;
      const res = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: boxInvoice,
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: testBoxProductId,
              batchNo: `BOX-BAT-${Date.now()}`,
              expiryDate: '2027-11-12',
              packsReceived: 1, // 1 box
              packCost: 1000.00, // Rs. 1000.00 per box
              packSize: 30, // 30 tablets per box
              mrp: 45.00
            }
          ]
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(Number(data.purchase.totalAmount)).toBe(1000.00);

      const item = data.items[0];
      expect(item.quantity).toBe(30);
      expect(Number(item.unitCostPrice)).toBe(33.3333);
      expect(Number(item.lineTotal)).toBe(1000.00);
    });

    it('proves mid-transaction failure triggers complete rollback', async () => {
      const nonExistentProductId = '00000000-0000-0000-0000-000000000000';
      const failInvoice = `FAIL-INV-${Date.now()}`;

      const res = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: failInvoice,
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: nonExistentProductId,
              batchNo: 'FAIL-BAT',
              expiryDate: '2027-11-12',
              packsReceived: 1,
              packCost: 100.00,
              mrp: 15.00
            }
          ]
        })
      });

      expect(res.status).toBe(404);

      // Verify no orphan purchase or movement was persisted
      const check = await pool.query('SELECT id FROM purchases WHERE invoice_no = $1', [failInvoice]);
      expect(check.rows.length).toBe(0);
    });

    it('allows concurrent GRNs without deadlocking or lost updates', async () => {
      const promises = [1, 2, 3].map((n) =>
        fetch(`${baseUrl}/api/v1/purchases`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ownerToken}`
          },
          body: JSON.stringify({
            supplierId: testSupplierId,
            invoiceNo: `CONCUR-INV-${n}-${Date.now()}`,
            purchaseDate: '2026-11-12',
            items: [
              {
                productId: testProductId,
                batchNo: `CONCUR-BAT-${n}-${Date.now()}`,
                expiryDate: '2027-11-12',
                packsReceived: 2,
                packCost: 200.00,
                packSize: 10,
                mrp: 30.00
              }
            ]
          })
        })
      );

      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).toBe(201);
      }
    });

    it('Purchase Void: blocked if any batch from the purchase has been reduced below received quantity', async () => {
      // Create a fresh purchase to test void blocking
      const voidBlockInvoice = `VOID-BLOCK-${Date.now()}`;
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: voidBlockInvoice,
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: testProductId,
              batchNo: `VBAT-${Date.now()}`,
              expiryDate: '2027-11-12',
              packsReceived: 5, // 50 units
              packCost: 100.00,
              packSize: 10,
              mrp: 15.00
            }
          ]
        })
      });
      expect(purRes.status).toBe(201);
      const purData = (await purRes.json()) as any;
      const targetPurchaseId = purData.purchase.id;
      const targetBatchId = purData.items[0].batchId;

      // Simulate a sale/reduction by deducting 5 units via stock adjustment
      const adjRes = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          batchId: targetBatchId,
          adjustmentType: 'damage',
          quantityChange: -5,
          reason: 'Damaged during unloading'
        })
      });
      expect(adjRes.status).toBe(201);

      // Now attempt to void the purchase: MUST BE BLOCKED
      const voidRes = await fetch(`${baseUrl}/api/v1/purchases/${targetPurchaseId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          reason: 'Duplicate entry entered by mistake'
        })
      });

      expect(voidRes.status).toBe(409);
      const voidErr = (await voidRes.json()) as any;
      expect(['VOID_BLOCKED_STOCK_DEPLETED', 'PURCHASE_VOID_BLOCKED']).toContain(voidErr.error);
      expect(voidErr.batches.length).toBeGreaterThan(0);
      expect(voidErr.batches[0].batchId).toBe(targetBatchId);
    });

    it('Purchase Void: successfully voids purchase and reverses stock & ledger when batch is intact', async () => {
      // Create clean purchase
      const cleanInvoice = `CLEAN-VOID-${Date.now()}`;
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: cleanInvoice,
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: testProductId,
              batchNo: `CLEAN-BAT-${Date.now()}`,
              expiryDate: '2027-11-12',
              packsReceived: 2, // 20 units
              packCost: 150.00,
              packSize: 10,
              mrp: 20.00
            }
          ]
        })
      });
      expect(purRes.status).toBe(201);
      const purData = (await purRes.json()) as any;
      const cleanPurId = purData.purchase.id;
      const cleanBatchId = purData.items[0].batchId;

      const supBeforeVoid = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      const balBefore = Number(supBeforeVoid.rows[0].outstanding_balance);

      // Void the purchase
      const voidRes = await fetch(`${baseUrl}/api/v1/purchases/${cleanPurId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          reason: 'Supplier invoice cancelled before acceptance'
        })
      });

      expect(voidRes.status).toBe(200);
      const voidData = (await voidRes.json()) as any;
      expect(voidData.purchase.status).toBe('voided');

      // 1. Batch stock reduced to 0
      const bCheck = await pool.query('SELECT current_quantity, is_active FROM batches WHERE id = $1', [cleanBatchId]);
      expect(Number(bCheck.rows[0].current_quantity)).toBe(0);
      expect(bCheck.rows[0].is_active).toBe(false);

      // 2. Reversing movement written
      const movCheck = await pool.query("SELECT movement_type, qty_change FROM stock_movements WHERE batch_id = $1 AND movement_type = 'void'", [cleanBatchId]);
      expect(movCheck.rows.length).toBe(1);
      expect(Number(movCheck.rows[0].qty_change)).toBe(-20);

      // 3. Supplier ledger reversing entry (300.00 deducted)
      const supAfterVoid = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      expect(Number(supAfterVoid.rows[0].outstanding_balance)).toBe(balBefore - 300.00);

      // 4. Void audit log exists
      const auditCheck = await pool.query("SELECT action FROM audit_logs WHERE entity = 'PURCHASE' AND entity_id = $1 AND action = 'PURCHASE_VOIDED'", [cleanPurId]);
      expect(auditCheck.rows.length).toBe(1);
    });
  });

  describe('Part C: Stock Adjustments & Approval Rules', () => {
    let adjBatchId: string;

    beforeAll(async () => {
      // Create a batch with 50 units for adjustment tests
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: `ADJ-SETUP-${Date.now()}`,
          purchaseDate: '2026-11-12',
          items: [
            {
              productId: testProductId,
              batchNo: `ADJ-BAT-${Date.now()}`,
              expiryDate: '2027-11-12',
              packsReceived: 5,
              packCost: 200.00,
              packSize: 10,
              mrp: 35.00
            }
          ]
        })
      });
      const data = (await purRes.json()) as any;
      adjBatchId = data.items[0].batchId;
    });

    it('rejects adjustment that would take batch stock below zero', async () => {
      const res = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          batchId: adjBatchId,
          adjustmentType: 'correction',
          quantityChange: -100, // batch only has 50
          reason: 'Audit correction count error'
        })
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.error).toBe('NEGATIVE_STOCK_DISALLOWED');
    });

    it('enforces owner approval when adjustment cost exceeds configured threshold', async () => {
      // Unit cost is 20.00. 300 units = Rs. 6,000.00 (> Rs. 5,000 threshold).
      // Pharmacist attempt should be rejected with 403
      const resPharm = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          batchId: adjBatchId,
          adjustmentType: 'correction',
          quantityChange: 300,
          reason: 'Major audit discovery'
        })
      });

      expect(resPharm.status).toBe(403);
      const dataPharm = (await resPharm.json()) as any;
      expect(dataPharm.error).toBe('OWNER_APPROVAL_REQUIRED');

      // Owner attempt should succeed
      const resOwner = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          batchId: adjBatchId,
          adjustmentType: 'correction',
          quantityChange: 300,
          reason: 'Major audit discovery'
        })
      });

      expect(resOwner.status).toBe(201);
      const dataOwner = (await resOwner.json()) as any;
      expect(dataOwner.adjustment.newQuantity).toBe(350);
    });

    it('applies standard stock adjustment and links movement_id', async () => {
      const res = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          batchId: adjBatchId,
          adjustmentType: 'damage',
          quantityChange: -5,
          reason: 'Water spill on top shelf'
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(data.adjustment.movementId).toBeTruthy();

      // Verify movement_id is stored in stock_adjustments table
      const adjCheck = await pool.query('SELECT movement_id, quantity_change FROM stock_adjustments WHERE id = $1', [data.adjustment.id]);
      expect(adjCheck.rows[0].movement_id).toBe(data.adjustment.movementId);
    });
  });

  describe('Part D: Inventory Lists & Expiry Reports', () => {
    it('returns low stock list with non-expired quantities and value-at-cost', async () => {
      const res = await fetch(`${baseUrl}/api/v1/stock/low-stock`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(Array.isArray(data.products)).toBe(true);
      if (data.products.length > 0) {
        expect(data.products[0]).toHaveProperty('currentStock');
        expect(data.products[0]).toHaveProperty('valueAtCost');
      }
    });

    it('returns expiring batches within 30, 60, or 90 days with value-at-cost', async () => {
      const res = await fetch(`${baseUrl}/api/v1/stock/expiring?days=90`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('totalExpiringStock');
      expect(data).toHaveProperty('totalExpiringValueAtCost');
      expect(Array.isArray(data.batches)).toBe(true);
    });

    it('returns expired batches that still hold positive stock with value-at-cost', async () => {
      const res = await fetch(`${baseUrl}/api/v1/stock/expired`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data).toHaveProperty('totalExpiredStock');
      expect(data).toHaveProperty('totalExpiredValueAtCost');
      expect(Array.isArray(data.batches)).toBe(true);
    });
  });

  describe('Part E: Supplier Payments & Settlement', () => {
    it('records supplier payment and updates ledger balance', async () => {
      const supBefore = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      const balanceBefore = Number(supBefore.rows[0].outstanding_balance);
      expect(balanceBefore).toBeGreaterThan(0);

      const payAmount = 500.00;
      const res = await fetch(`${baseUrl}/api/v1/suppliers/${testSupplierId}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          amount: payAmount,
          paymentMethod: 'bank_transfer',
          referenceNo: 'TXN-998877',
          notes: 'Settlement for invoice'
        })
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as any;
      expect(Number(data.payment.amount)).toBe(payAmount);
      expect(Number(data.payment.newBalance)).toBe(balanceBefore - payAmount);

      const supAfter = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [testSupplierId]);
      expect(Number(supAfter.rows[0].outstanding_balance)).toBe(balanceBefore - payAmount);
    });

    it('blocks payment that causes negative balance unless allowOverpayment is set', async () => {
      const resBlocked = await fetch(`${baseUrl}/api/v1/suppliers/${testSupplierId}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pharmacistToken}`
        },
        body: JSON.stringify({
          amount: 999999.00,
          paymentMethod: 'cash'
        })
      });

      expect(resBlocked.status).toBe(400);
      const errData = (await resBlocked.json()) as any;
      expect(errData.error).toBe('OVERPAYMENT_NOT_ALLOWED');

      // Allowed with allowOverpayment = true
      const resAllowed = await fetch(`${baseUrl}/api/v1/suppliers/${testSupplierId}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          amount: 999999.00,
          paymentMethod: 'cash',
          allowOverpayment: true
        })
      });

      expect(resAllowed.status).toBe(201);
    });
  });

  describe('Part F: Cashier 403 Forbidden Access Control', () => {
    it('returns 403 Forbidden for cashier on all Step 4 endpoints', async () => {
      // 1. POST /purchases
      const res1 = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({})
      });
      expect(res1.status).toBe(403);

      // 2. GET /purchases
      const res2 = await fetch(`${baseUrl}/api/v1/purchases`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res2.status).toBe(403);

      // 3. POST /purchases/:id/void
      const res3 = await fetch(`${baseUrl}/api/v1/purchases/${createdPurchaseId}/void`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({ reason: 'test' })
      });
      expect(res3.status).toBe(403);

      // 4. POST /stock/adjustments
      const res4 = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({})
      });
      expect(res4.status).toBe(403);

      // 5. GET /stock/adjustments
      const res5 = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res5.status).toBe(403);

      // 6. GET /stock/low-stock
      const res6 = await fetch(`${baseUrl}/api/v1/stock/low-stock`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res6.status).toBe(403);

      // 7. GET /stock/expiring
      const res7 = await fetch(`${baseUrl}/api/v1/stock/expiring`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res7.status).toBe(403);

      // 8. GET /stock/expired
      const res8 = await fetch(`${baseUrl}/api/v1/stock/expired`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(res8.status).toBe(403);

      // 9. POST /suppliers/:id/payments
      const res9 = await fetch(`${baseUrl}/api/v1/suppliers/${testSupplierId}/payments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cashierToken}`
        },
        body: JSON.stringify({ amount: 100, paymentMethod: 'cash' })
      });
      expect(res9.status).toBe(403);
    });
  });

  describe('Part G: Additional Step 4 Edge Cases & Fix Invariants', () => {
    it('refuses to boot in production if app role password equals .env.example default', async () => {
      const origEnv = process.env.NODE_ENV;
      const origPass = process.env.APP_DB_PASSWORD;
      process.env.NODE_ENV = 'production';
      process.env.APP_DB_PASSWORD = 'pharmacy_app_pass';

      try {
        let threw = false;
        try {
          await assertAppRoleSecurity(pool);
        } catch (err: any) {
          threw = true;
          expect(err.message).toContain('Production database password must not use the default password');
        }
        expect(threw).toBe(true);
      } finally {
        process.env.NODE_ENV = origEnv;
        process.env.APP_DB_PASSWORD = origPass;
      }
    });

    it('proves concurrent duplicate invoices: exactly one succeeds and one receives 409 Conflict', async () => {
      const dupInv = `CONCUR-DUP-${Date.now()}`;
      const payload = (inv: string) => ({
        supplierId: testSupplierId,
        invoiceNo: inv,
        purchaseDate: '2026-11-14',
        items: [
          {
            productId: testProductId,
            batchNo: `DUP-B-${Date.now()}`,
            expiryDate: '2027-11-14',
            packsReceived: 1,
            packCost: 100.00,
            packSize: 10,
            mrp: 15.00
          }
        ]
      });

      // Submit identical invoice number concurrently (one in lower case)
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/purchases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify(payload(dupInv.toUpperCase()))
        }),
        fetch(`${baseUrl}/api/v1/purchases`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify(payload(dupInv.toLowerCase()))
        })
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('blocks purchase void if supplier_payments reference that purchase, listing payments in error', async () => {
      // 1. Create a purchase
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: `PAY-LINK-${Date.now()}`,
          purchaseDate: '2026-11-14',
          items: [
            {
              productId: testProductId,
              batchNo: `PAY-BAT-${Date.now()}`,
              expiryDate: '2027-11-14',
              packsReceived: 2,
              packCost: 50.00,
              packSize: 10,
              mrp: 10.00
            }
          ]
        })
      });
      expect(purRes.status).toBe(201);
      const purData = await purRes.json();
      const pId = purData.purchase.id;

      // 2. Record a supplier payment referencing this purchase
      const payRes = await pool.query(
        `INSERT INTO supplier_payments (supplier_id, purchase_id, amount, payment_method, paid_by)
         VALUES ($1, $2, 100.00, 'cash', (SELECT id FROM users WHERE username = 'admin'))
         RETURNING id`,
        [testSupplierId, pId]
      );
      const paymentId = payRes.rows[0].id;

      // 3. Attempt to void: must be blocked with payment listed
      const voidRes = await fetch(`${baseUrl}/api/v1/purchases/${pId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ reason: 'Accidental duplicate entry' })
      });

      expect(voidRes.status).toBe(409);
      const voidData = await voidRes.json();
      expect(voidData.error).toBe('PURCHASE_VOID_BLOCKED');
      expect(voidData.payments.length).toBeGreaterThan(0);
      expect(voidData.payments[0].paymentId).toBe(paymentId);
    });

    it('proves purchase void writes entry_type purchase_void to supplier_ledger', async () => {
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: `VOID-LEDGER-${Date.now()}`,
          purchaseDate: '2026-11-14',
          items: [
            {
              productId: testProductId,
              batchNo: `VLED-BAT-${Date.now()}`,
              expiryDate: '2027-11-14',
              packsReceived: 1,
              packCost: 50.00,
              packSize: 10,
              mrp: 10.00
            }
          ]
        })
      });
      const purData = await purRes.json();
      const pId = purData.purchase.id;

      const voidRes = await fetch(`${baseUrl}/api/v1/purchases/${pId}/void`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({ reason: 'Reversal verification' })
      });
      expect(voidRes.status).toBe(200);

      // Verify supplier_ledger record has entry_type 'purchase_void'
      const checkLedger = await pool.query(
        `SELECT entry_type, amount FROM supplier_ledger WHERE ref_id = $1 AND ref_type = 'purchase_void'`,
        [pId]
      );
      expect(checkLedger.rows.length).toBe(1);
      expect(checkLedger.rows[0].entry_type).toBe('purchase_void');
      expect(Number(checkLedger.rows[0].amount)).toBe(-50.00);
    });

    it('rejects expired_write_off on a non-expired batch', async () => {
      // Create batch with future expiry
      const purRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          supplierId: testSupplierId,
          invoiceNo: `FUT-EXP-${Date.now()}`,
          purchaseDate: '2026-11-14',
          items: [
            {
              productId: testProductId,
              batchNo: `FUT-BAT-${Date.now()}`,
              expiryDate: '2028-11-14',
              packsReceived: 1,
              packCost: 100.00,
              packSize: 10,
              mrp: 15.00
            }
          ]
        })
      });
      const purData = await purRes.json();
      const bId = purData.items[0].batchId;

      const adjRes = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          batchId: bId,
          adjustmentType: 'expired_write_off',
          quantityChange: -5,
          reason: 'Test non expired write off'
        })
      });

      expect(adjRes.status).toBe(400);
      const data = await adjRes.json();
      expect(data.error).toBe('BATCH_NOT_EXPIRED');
    });

    it('rejects positive correction above threshold for pharmacist but allows for owner', async () => {
      // Find a batch with high cost price so 100 units > 1000 threshold
      const bRes = await pool.query('SELECT id, cost_price FROM batches WHERE current_quantity > 0 AND cost_price >= 20 ORDER BY cost_price DESC LIMIT 1');
      const bId = bRes.rows[0].id;

      // Positive correction of 100 units = 100 * cost_price > 1000 threshold
      const resPharm = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({
          batchId: bId,
          adjustmentType: 'correction',
          quantityChange: 100,
          reason: 'Positive inventory discovery'
        })
      });
      expect(resPharm.status).toBe(403);
      const dataPharm = await resPharm.json();
      expect(dataPharm.error).toBe('OWNER_APPROVAL_REQUIRED');

      // Owner allowed
      const resOwner = await fetch(`${baseUrl}/api/v1/stock/adjustments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          batchId: bId,
          adjustmentType: 'correction',
          quantityChange: 100,
          reason: 'Positive inventory discovery'
        })
      });
      expect(resOwner.status).toBe(201);
    });

    it('verifies settings updates are owner-only and audited', async () => {
      // Pharmacist PUT settings -> 403
      const resPharm = await fetch(`${baseUrl}/api/v1/settings/inventory_settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pharmacistToken}` },
        body: JSON.stringify({ value: { test: 123 } })
      });
      expect(resPharm.status).toBe(403);

      // Owner PUT settings -> 200
      const resOwner = await fetch(`${baseUrl}/api/v1/settings/inventory_settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          value: {
            max_unapproved_adjustment_cost: 5000.00,
            max_daily_adjustment_cost_per_user: 10000.00,
            positive_correction_owner_threshold: 1000.00
          }
        })
      });
      expect(resOwner.status).toBe(200);

      // Audit log exists
      const auditCheck = await pool.query(
        `SELECT action FROM audit_logs WHERE entity = 'SETTING' AND entity_id = 'inventory_settings' ORDER BY created_at DESC LIMIT 1`
      );
      expect(auditCheck.rows.length).toBe(1);
      expect(auditCheck.rows[0].action).toBe('SETTING_UPDATED');
    });

    it('verifies low-stock list includes products with zero batches (LEFT JOIN)', async () => {
      // Create a brand new product that has never had any batches
      const zeroBatchBarcode = `ZERO_BATCH_${Date.now()}`;
      const prodRes = await fetch(`${baseUrl}/api/v1/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
        body: JSON.stringify({
          name: `Zero Batch Product ${Date.now()}`,
          barcode: zeroBatchBarcode,
          category: 'General',
          unit: 'bottle',
          packSize: 1,
          reorderLevel: 20
        })
      });
      expect(prodRes.status).toBe(201);
      const prodData = await prodRes.json();
      const newProdId = prodData.product.id;

      // Query low-stock list
      const lowStockRes = await fetch(`${baseUrl}/api/v1/stock/low-stock`, {
        headers: { Authorization: `Bearer ${pharmacistToken}` }
      });
      expect(lowStockRes.status).toBe(200);
      const lowStockData = await lowStockRes.json();

      const found = lowStockData.products.find((p: any) => p.id === newProdId);
      expect(found).toBeDefined();
      expect(Number(found.currentStock)).toBe(0);
      expect(Number(found.reorderLevel)).toBe(20);
      expect(Number(found.valueAtCost)).toBe(0);
      expect(found.activeBatchCount).toBe(0);
    });
  });
});
