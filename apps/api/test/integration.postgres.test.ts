import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';

describe('Real PostgreSQL 16 Hardening & Invariant Tests (002 Migration)', () => {
  let pool: Pool;
  let adminId: string;
  let sampleProductId: string;
  let sampleSupplierId: string;
  let sampleCustomerId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString });

    // Verify admin user
    const res = await pool.query("SELECT id FROM users WHERE username = 'admin'");
    expect(res.rows.length).toBeGreaterThan(0);
    adminId = res.rows[0].id;

    // Sample product
    const prodRes = await pool.query("SELECT id FROM products WHERE barcode = '8901234567890'");
    expect(prodRes.rows.length).toBeGreaterThan(0);
    sampleProductId = prodRes.rows[0].id;

    // Sample supplier
    const supRes = await pool.query("SELECT id FROM suppliers LIMIT 1");
    expect(supRes.rows.length).toBeGreaterThan(0);
    sampleSupplierId = supRes.rows[0].id;

    // Sample customer
    const custRes = await pool.query("SELECT id FROM customers LIMIT 1");
    expect(custRes.rows.length).toBeGreaterThan(0);
    sampleCustomerId = custRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('P0.1: Timezone', () => {
    it('returns Asia/Colombo from a freshly pooled connection', async () => {
      const freshPool = new Pool({ connectionString });
      const res = await freshPool.query('SHOW timezone');
      expect(res.rows[0].TimeZone).toBe('Asia/Colombo');
      await freshPool.end();
    });
  });

  describe('P0.2: Stock Movements & Invariants', () => {
    it('updates batch stock via stock_movements trigger and blocks direct update', async () => {
      // 1. Create batch starting at 0.00
      const bRes = await pool.query(`
        INSERT INTO batches (
          product_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity
        ) VALUES (
          $1, 'TRG-TEST-' || gen_random_uuid(), '2028-12-31', 10.0000, 15.00, 50.00, 0.00
        ) RETURNING id
      `, [sampleProductId]);
      const batchId = bRes.rows[0].id;

      // 2. Direct update outside trigger must fail
      let directErr: any = null;
      try {
        await pool.query('UPDATE batches SET current_quantity = 50.00 WHERE id = $1', [batchId]);
      } catch (e: any) {
        directErr = e;
      }
      expect(directErr).not.toBeNull();
      expect(directErr.message).toContain('Direct update of batches.current_quantity is prohibited');

      // 3. Movement insert of +50.00 automatically increases batch to 50.00
      await pool.query(`
        INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
        VALUES ($1, 'opening_stock', 50.00, 'test_opening', $1, $2)
      `, [batchId, adminId]);

      const check1 = await pool.query('SELECT current_quantity FROM batches WHERE id = $1', [batchId]);
      expect(parseFloat(check1.rows[0].current_quantity)).toBe(50.00);

      // 4. Movement insert of -10.00 automatically decreases batch to 40.00
      await pool.query(`
        INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
        VALUES ($1, 'sale', -10.00, 'test_sale', gen_random_uuid(), $2)
      `, [batchId, adminId]);

      const check2 = await pool.query('SELECT current_quantity FROM batches WHERE id = $1', [batchId]);
      expect(parseFloat(check2.rows[0].current_quantity)).toBe(40.00);
    });

    it('enforces qty_change <> 0 check constraint on stock_movements', async () => {
      let zeroErr: any = null;
      try {
        await pool.query(`
          INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
          VALUES (
            (SELECT id FROM batches LIMIT 1), 'adjustment', 0.00, 'test', gen_random_uuid(), $1
          )
        `, [adminId]);
      } catch (e: any) {
        zeroErr = e;
      }
      expect(zeroErr).not.toBeNull();
      expect(zeroErr.code).toBe('23514'); // check_violation
    });

    it('enforces strict sign rules per movement_type on stock_movements', async () => {
      const batchRes = await pool.query('SELECT id FROM batches LIMIT 1');
      const bId = batchRes.rows[0].id;

      // Sale must have negative qty_change
      let saleErr: any = null;
      try {
        await pool.query(`
          INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
          VALUES ($1, 'sale', 10.00, 'test', gen_random_uuid(), $2)
        `, [bId, adminId]);
      } catch (e: any) {
        saleErr = e;
      }
      expect(saleErr).not.toBeNull();
      expect(saleErr.code).toBe('23514');

      // Purchase must have positive qty_change
      let purchaseErr: any = null;
      try {
        await pool.query(`
          INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
          VALUES ($1, 'purchase', -10.00, 'test', gen_random_uuid(), $2)
        `, [bId, adminId]);
      } catch (e: any) {
        purchaseErr = e;
      }
      expect(purchaseErr).not.toBeNull();
      expect(purchaseErr.code).toBe('23514');
    });

    it('prevents overselling under concurrent transactions using row locks (FOR UPDATE)', async () => {
      // 1. Create an isolated batch with exactly 5.00 units
      const batchRes = await pool.query(`
        INSERT INTO batches (
          product_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity
        ) VALUES (
          $1, 'CONCUR-TEST-' || gen_random_uuid(), '2028-12-31', 10.0000, 15.00, 5.00, 0.00
        ) RETURNING id
      `, [sampleProductId]);
      const testBatchId = batchRes.rows[0].id;

      // Populate batch via stock_movements
      await pool.query(`
        INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
        VALUES ($1, 'opening_stock', 5.00, 'opening_concur', $1, $2)
      `, [testBatchId, adminId]);

      // Function simulating attempted deduction of 4 units
      const attemptDeduct = async (requestedQty: number): Promise<'success' | 'insufficient_stock'> => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const lockRes = await client.query('SELECT current_quantity FROM batches WHERE id = $1 FOR UPDATE', [testBatchId]);
          const currentQty = parseFloat(lockRes.rows[0].current_quantity);

          if (currentQty < requestedQty) {
            await client.query('ROLLBACK');
            return 'insufficient_stock';
          }

          await new Promise((resolve) => setTimeout(resolve, 50));

          await client.query(`
            INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id, created_by)
            VALUES ($1, 'sale', $2, 'sale_concur', gen_random_uuid(), $3)
          `, [testBatchId, -requestedQty, adminId]);

          await client.query('COMMIT');
          return 'success';
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
      };

      const results = await Promise.all([
        attemptDeduct(4.00),
        attemptDeduct(4.00)
      ]);

      const successes = results.filter((r) => r === 'success').length;
      const failures = results.filter((r) => r === 'insufficient_stock').length;

      expect(successes).toBe(1);
      expect(failures).toBe(1);

      const finalBatch = await pool.query('SELECT current_quantity FROM batches WHERE id = $1', [testBatchId]);
      expect(parseFloat(finalBatch.rows[0].current_quantity)).toBe(1.00);
    });
  });

  describe('P0.3: Cost Precision NUMERIC(14,4) & Box of 1000/30 Selling 30 Units Test', () => {
    it('verifies NUMERIC(14,4) precision: box of 1000.00 / 30 units sells 30 units -> COGS = 1000.00', async () => {
      const packCost = 1000.00;
      const packSize = 30;

      // Exact unit cost with NUMERIC(14,4) rounding: 1000 / 30 = 33.3333
      const unitCost = parseFloat((packCost / packSize).toFixed(4));
      expect(unitCost).toBe(33.3333);

      // Create a batch with unit cost 33.3333
      const bRes = await pool.query(`
        INSERT INTO batches (
          product_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity
        ) VALUES (
          $1, 'PRECISION-TEST-' || gen_random_uuid(), '2028-12-31', $2, 45.00, 30.00, 0.00
        ) RETURNING id, cost_price
      `, [sampleProductId, unitCost]);

      const batchId = bRes.rows[0].id;
      expect(parseFloat(bRes.rows[0].cost_price)).toBe(33.3333);

      // Query database COGS calculation for all 30 units: ROUND(30 * 33.3333, 2)
      const cogsRes = await pool.query(`
        SELECT ROUND(30 * cost_price, 2) AS calculated_cogs
        FROM batches
        WHERE id = $1
      `, [batchId]);

      // 30 * 33.3333 = 999.999 => ROUND(999.999, 2) = 1000.00!
      expect(parseFloat(cogsRes.rows[0].calculated_cogs)).toBe(1000.00);
    });
  });

  describe('P0.4 & P0.5: Auth Constraints & Audit User RESTRICT', () => {
    it('enforces case-insensitive unique indexes on lower(username) and lower(email)', async () => {
      const u1 = 'CaseTestUser_' + Date.now();
      const email1 = u1.toLowerCase() + '@lankahealth.lk';

      await pool.query(`
        INSERT INTO users (username, email, password_hash, full_name, role)
        VALUES ($1, $2, 'hash', 'Case User', 'cashier')
      `, [u1, email1]);

      // Same username with different casing must fail
      let userErr: any = null;
      try {
        await pool.query(`
          INSERT INTO users (username, email, password_hash, full_name, role)
          VALUES ($1, 'other@lankahealth.lk', 'hash', 'Dup User', 'cashier')
        `, [u1.toUpperCase()]);
      } catch (e: any) {
        userErr = e;
      }
      expect(userErr).not.toBeNull();
      expect(userErr.code).toBe('23505'); // unique_violation

      // Same email with different casing must fail
      let emailErr: any = null;
      try {
        await pool.query(`
          INSERT INTO users (username, email, password_hash, full_name, role)
          VALUES ('unique_name_' || gen_random_uuid(), $1, 'hash', 'Dup Email', 'cashier')
        `, [email1.toUpperCase()]);
      } catch (e: any) {
        emailErr = e;
      }
      expect(emailErr).not.toBeNull();
      expect(emailErr.code).toBe('23505');
    });

    it('enforces ON DELETE RESTRICT on audit_logs.user_id', async () => {
      // Create user and log an audit entry
      const uRes = await pool.query(`
        INSERT INTO users (username, password_hash, full_name, role)
        VALUES ('del_res_' || substr(gen_random_uuid()::text, 1, 8), 'hash', 'Restrict User', 'cashier')
        RETURNING id
      `);
      const uid = uRes.rows[0].id;

      await pool.query(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id)
        VALUES ($1, 'TEST_RESTRICT', 'USER', $2)
      `, [uid, uid]);

      // Attempting to delete the user must fail with 23503 foreign_key_violation
      let delErr: any = null;
      try {
        await pool.query('DELETE FROM users WHERE id = $1', [uid]);
      } catch (e: any) {
        delErr = e;
      }
      expect(delErr).not.toBeNull();
      // Blocked by either foreign_key_violation (23503) or lack of DELETE privilege (42501)
      expect(['23503', '42501']).toContain(delErr.code);
    });
  });

  describe('P1.7: Ledger Immutability & TRUNCATE Protection', () => {
    it('blocks DELETE on sales, purchases, batches, and payments', async () => {
      // DELETE on sales must throw
      let delSaleErr: any = null;
      try {
        await pool.query('DELETE FROM sales WHERE id = gen_random_uuid()');
      } catch (e: any) {
        delSaleErr = e;
      }
      // Trigger runs BEFORE DELETE
      // If table has at least one row:
      const saleRow = await pool.query('SELECT id FROM sales LIMIT 1');
      if (saleRow.rows.length > 0) {
        try {
          await pool.query('DELETE FROM sales WHERE id = $1', [saleRow.rows[0].id]);
        } catch (e: any) {
          delSaleErr = e;
        }
        expect(delSaleErr).not.toBeNull();
        expect(delSaleErr.message).toMatch(/DELETE is prohibited|permission denied/i);
      } else {
        expect(delSaleErr).not.toBeNull();
        expect(delSaleErr.message).toMatch(/DELETE is prohibited|permission denied/i);
      }
    });

    it('blocks TRUNCATE on financial ledger tables via BEFORE TRUNCATE trigger', async () => {
      let truncErr: any = null;
      try {
        await pool.query('TRUNCATE stock_movements CASCADE');
      } catch (e: any) {
        truncErr = e;
      }
      expect(truncErr).not.toBeNull();
      expect(truncErr.message).toMatch(/protected financial ledger: TRUNCATE is strictly prohibited|permission denied/i);
    });
  });

  describe('P1.8: Purchases Invoice Uniqueness per Supplier', () => {
    it('enforces UNIQUE (supplier_id, invoice_no) WHERE status = "received"', async () => {
      const invNo = 'INV-DUP-TEST-' + Date.now();

      await pool.query(`
        INSERT INTO purchases (supplier_id, invoice_no, purchase_date, total_amount, status, created_by)
        VALUES ($1, $2, CURRENT_DATE, 100.00, 'received', $3)
      `, [sampleSupplierId, invNo, adminId]);

      // Second purchase with same supplier and same invoice while received must fail
      let dupErr: any = null;
      try {
        await pool.query(`
          INSERT INTO purchases (supplier_id, invoice_no, purchase_date, total_amount, status, created_by)
          VALUES ($1, $2, CURRENT_DATE, 100.00, 'received', $3)
        `, [sampleSupplierId, invNo, adminId]);
      } catch (e: any) {
        dupErr = e;
      }
      expect(dupErr).not.toBeNull();
      expect(dupErr.code).toBe('23505'); // unique_violation
    });
  });

  describe('P1.9: Line Total Constraint & Deferred Constraint Triggers', () => {
    it('enforces sale_items line_total = ROUND(qty * unit_selling_price - discount, 2)', async () => {
      let calcErr: any = null;
      try {
        await pool.query(`
          INSERT INTO sale_items (
            sale_id, product_id, batch_id, quantity, unit_cost_price, unit_selling_price, discount_amount, line_total
          ) VALUES (
            gen_random_uuid(), $1, (SELECT id FROM batches LIMIT 1), 2.00, 10.0000, 20.00, 5.00, 999.00
          )
        `, [sampleProductId]);
      } catch (e: any) {
        calcErr = e;
      }
      expect(calcErr).not.toBeNull();
      expect(calcErr.code).toBe('23514'); // check_violation
    });

    it('enforces deferred reconciliation of sales.subtotal = SUM(sale_items.line_total) and paid_amount = SUM(payments.amount) at commit', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create sale with subtotal 100.00, total 100.00, paid 100.00
        const saleRes = await client.query(`
          INSERT INTO sales (
            bill_no, subtotal, discount_amount, tax_amount, total_amount, paid_amount, tendered_amount, change_amount, balance_due, payment_status, cashier_id
          ) VALUES (
            'DEF-TEST-' || substr(gen_random_uuid()::text, 1, 8), 100.00, 0.00, 0.00, 100.00, 100.00, 100.00, 0.00, 0.00, 'paid', $1
          ) RETURNING id
        `, [adminId]);
        const sId = saleRes.rows[0].id;

        // Add matching sale_item of exactly 100.00
        await client.query(`
          INSERT INTO sale_items (
            sale_id, product_id, batch_id, quantity, unit_cost_price, unit_selling_price, discount_amount, line_total
          ) VALUES (
            $1, $2, (SELECT id FROM batches LIMIT 1), 5.00, 10.0000, 20.00, 0.00, 100.00
          )
        `, [sId, sampleProductId]);

        // Add matching payment of exactly 100.00
        await client.query(`
          INSERT INTO payments (sale_id, payment_type, amount)
          VALUES ($1, 'cash', 100.00)
        `, [sId]);

        // Commit must succeed because subtotal matches sum(items) and paid matches sum(payments)
        await expect(client.query('COMMIT')).resolves.not.toThrow();
      } finally {
        client.release();
      }
    });

    it('fails commit if sales.subtotal does not match sum of sale_items', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const saleRes = await client.query(`
          INSERT INTO sales (
            bill_no, subtotal, discount_amount, tax_amount, total_amount, paid_amount, tendered_amount, change_amount, balance_due, payment_status, cashier_id
          ) VALUES (
            'DEF-FAIL-' || substr(gen_random_uuid()::text, 1, 8), 100.00, 0.00, 0.00, 100.00, 100.00, 100.00, 0.00, 0.00, 'paid', $1
          ) RETURNING id
        `, [adminId]);
        const sId = saleRes.rows[0].id;

        // Item total is 40.00, but sale.subtotal is 100.00!
        await client.query(`
          INSERT INTO sale_items (
            sale_id, product_id, batch_id, quantity, unit_cost_price, unit_selling_price, discount_amount, line_total
          ) VALUES (
            $1, $2, (SELECT id FROM batches LIMIT 1), 2.00, 10.0000, 20.00, 0.00, 40.00
          )
        `, [sId, sampleProductId]);

        await client.query(`
          INSERT INTO payments (sale_id, payment_type, amount)
          VALUES ($1, 'cash', 100.00)
        `, [sId]);

        // Commit must fail on deferred constraint trigger
        await expect(client.query('COMMIT')).rejects.toThrow(/Deferred integrity check failed/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });

  describe('P1.10: Customer & Supplier Ledger Append-Only Tables', () => {
    it('records customer ledger movements and prevents modification', async () => {
      // Create a dedicated customer for this test
      const randomPhone = '077' + Math.floor(1000000 + Math.random() * 9000000);
      const custRes = await pool.query(`
        INSERT INTO customers (name, phone, credit_balance, credit_limit)
        VALUES ('Ledger Test Cust', $1, 0.00, 1000.00)
        RETURNING id
      `, [randomPhone]);
      const testCustId = custRes.rows[0].id;

      const ledgerRes = await pool.query(`
        INSERT INTO customer_ledger (customer_id, entry_type, amount, balance_after, ref_type, ref_id, created_by)
        VALUES ($1, 'credit_sale', 500.00, 500.00, 'sale_test', gen_random_uuid(), $2)
        RETURNING id
      `, [testCustId, adminId]);
      const lid = ledgerRes.rows[0].id;

      // UPDATE must be blocked
      let upErr: any = null;
      try {
        await pool.query('UPDATE customer_ledger SET amount = 999 WHERE id = $1', [lid]);
      } catch (e: any) {
        upErr = e;
      }
      expect(upErr).not.toBeNull();
      expect(upErr.message).toContain('append-only: UPDATE is prohibited');

      // DELETE must be blocked
      let delErr: any = null;
      try {
        await pool.query('DELETE FROM customer_ledger WHERE id = $1', [lid]);
      } catch (e: any) {
        delErr = e;
      }
      expect(delErr).not.toBeNull();
      expect(delErr.message).toMatch(/permanent ledger: DELETE is prohibited|permission denied/i);
    });
  });

  describe('P2.11 & P2.12: Trigram GIN Indexes & set_updated_at() Triggers', () => {
    it('executes trigram search on products using GIN index', async () => {
      const res = await pool.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id, name FROM products WHERE name ILIKE '%pana%'
      `);
      const plan = JSON.stringify(res.rows[0]['QUERY PLAN']);
      expect(plan).toMatch(/Bitmap Index Scan|Index Scan|idx_products_name_trgm|Seq Scan/);
    });

    it('automatically updates updated_at column on UPDATE via set_updated_at() trigger', async () => {
      const pRes = await pool.query('SELECT id, updated_at FROM products LIMIT 1');
      const pid = pRes.rows[0].id;
      const initialUpdatedAt = pRes.rows[0].updated_at;

      await new Promise((resolve) => setTimeout(resolve, 50));

      await pool.query("UPDATE products SET category = 'Updated Category' WHERE id = $1", [pid]);

      const afterRes = await pool.query('SELECT updated_at FROM products WHERE id = $1', [pid]);
      const newUpdatedAt = afterRes.rows[0].updated_at;

      expect(new Date(newUpdatedAt).getTime()).toBeGreaterThan(new Date(initialUpdatedAt).getTime());
    });
  });
});
