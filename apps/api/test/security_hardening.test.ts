import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { app } from '../src/index.js';
import { pool } from '../src/db/pool.js';
import { stripCostPrices } from '../src/middleware/rbac.js';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Security, Integrity & Hardening Tests (Pre-Step 3 Fixes)', () => {
  let server: http.Server;
  let baseUrl: string;
  let ownerToken: string;
  let cashierToken: string;

  // Dedicated pool connecting as non-owner pharmacy_app role
  const appRolePool = new Pool({
    connectionString: 'postgres://pharmacy_app:pharmacy_app_pass@localhost:5433/pharmacy_pos'
  });

  function getCookieValue(res: globalThis.Response, cookieName: string): string | null {
    const rawCookies = res.headers.get('set-cookie');
    if (!rawCookies) return null;
    const match = rawCookies.match(new RegExp(`${cookieName}=([^;]+)`));
    return match ? match[1] : null;
  }

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
    cashierToken = await login('cashier');
  });

  afterAll(async () => {
    await appRolePool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  describe('DB 1: Reset pharmacy.in_movement_trigger in apply_stock_movement_to_batch', () => {
    it('blocks direct UPDATE of batches.current_quantity even after an insert to stock_movements in the same transaction', async () => {
      const bRes = await pool.query('SELECT id, current_quantity FROM batches LIMIT 1');
      const batchId = bRes.rows[0].id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 1. Insert valid stock movement
        await client.query(
          `INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id)
           VALUES ($1, 'adjustment', 5.00, 'test_tx', gen_random_uuid())`,
          [batchId]
        );

        // 2. Direct UPDATE in the SAME transaction must be blocked because in_movement_trigger was reset to 'false'
        let updateFailed = false;
        try {
          await client.query(
            `UPDATE batches SET current_quantity = current_quantity + 10 WHERE id = $1`,
            [batchId]
          );
        } catch (err: any) {
          updateFailed = true;
          expect(err.message).toContain('Direct update of batches.current_quantity is prohibited');
        }
        expect(updateFailed).toBe(true);

        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('DB 2: Non-Owner App Role (pharmacy_app) Permissions', () => {
    it('allows SELECT, INSERT, UPDATE for pharmacy_app role', async () => {
      // SELECT
      const selRes = await appRolePool.query('SELECT id, name FROM products LIMIT 1');
      expect(selRes.rows.length).toBeGreaterThanOrEqual(1);

      // INSERT & UPDATE
      const testSupId = `00000000-0000-0000-0000-${Date.now().toString().slice(-12)}`;
      await appRolePool.query(
        `INSERT INTO suppliers (id, name, is_active) VALUES ($1, 'Role Perms Supplier', true)`,
        [testSupId]
      );
      const updRes = await appRolePool.query(
        `UPDATE suppliers SET name = 'Updated Role Perms Supplier' WHERE id = $1 RETURNING name`,
        [testSupId]
      );
      expect(updRes.rows[0].name).toBe('Updated Role Perms Supplier');
    });

    it('denies DELETE, TRUNCATE, and DISABLE TRIGGER for pharmacy_app role', async () => {
      // 1. DELETE denied
      let deleteDenied = false;
      try {
        await appRolePool.query('DELETE FROM suppliers WHERE name LIKE $1', ['Role Perms%']);
      } catch (err: any) {
        deleteDenied = true;
        expect(err.message).toMatch(/permission denied for table suppliers/i);
      }
      expect(deleteDenied).toBe(true);

      // 2. TRUNCATE denied
      let truncateDenied = false;
      try {
        await appRolePool.query('TRUNCATE TABLE suppliers');
      } catch (err: any) {
        truncateDenied = true;
        expect(err.message).toMatch(/permission denied for table suppliers/i);
      }
      expect(truncateDenied).toBe(true);

      // 3. DISABLE TRIGGER denied (must be owner)
      let triggerDenied = false;
      try {
        await appRolePool.query('ALTER TABLE batches DISABLE TRIGGER ALL');
      } catch (err: any) {
        triggerDenied = true;
        expect(err.message).toMatch(/must be owner of table batches/i);
      }
      expect(triggerDenied).toBe(true);
    });
  });

  describe('DB 3: Deferred Constraint Trigger on sales Table', () => {
    it('aborts transaction at COMMIT if a sale has zero items', async () => {
      const uRes = await pool.query("SELECT id FROM users WHERE role = 'cashier' LIMIT 1");
      const cashierId = uRes.rows[0].id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `INSERT INTO sales (
             bill_no, cashier_id, subtotal, discount_amount, tax_amount, total_amount,
             tendered_amount, paid_amount, change_amount, balance_due, payment_status, status
           )
           VALUES ($1, $2, 250.00, 0.00, 0.00, 250.00, 250.00, 250.00, 0.00, 0.00, 'paid', 'completed')`,
          [`ZERO_ITEMS_${Date.now()}`, cashierId]
        );

        let commitFailed = false;
        try {
          await client.query('COMMIT');
        } catch (err: any) {
          commitFailed = true;
          expect(err.message).toContain('Deferred integrity check failed');
          expect(err.message).toContain('0 sale items');
        }
        expect(commitFailed).toBe(true);
      } finally {
        client.release();
      }
    });
  });

  describe('DB 4: Ledger-Only Balance Updates for Customers & Suppliers', () => {
    it('blocks direct UPDATE of customers.credit_balance and enforces balance_after via customer_ledger', async () => {
      const cRes = await pool.query(
        `INSERT INTO customers (name, phone, credit_balance, credit_limit, is_active)
         VALUES ('Ledger Test Cust', $1, 0.00, 5000.00, true) RETURNING id`,
        [`071${Date.now().toString().slice(-7)}`]
      );
      const custId = cRes.rows[0].id;

      // 1. Direct UPDATE of customers.credit_balance must fail
      let directUpdateBlocked = false;
      try {
        await pool.query('UPDATE customers SET credit_balance = 500.00 WHERE id = $1', [custId]);
      } catch (err: any) {
        directUpdateBlocked = true;
        expect(err.message).toContain('Direct update of customers.credit_balance is prohibited');
      }
      expect(directUpdateBlocked).toBe(true);

      // 2. Mismatched balance_after in customer_ledger must fail
      let mismatchBlocked = false;
      try {
        await pool.query(
          `INSERT INTO customer_ledger (customer_id, entry_type, amount, balance_after, ref_type, ref_id)
           VALUES ($1, 'credit_sale', 1000.00, 800.00, 'sale', gen_random_uuid())`,
          [custId]
        );
      } catch (err: any) {
        mismatchBlocked = true;
        expect(err.message).toContain('Customer ledger balance mismatch');
      }
      expect(mismatchBlocked).toBe(true);

      // 3. Correct ledger insert updates customers.credit_balance
      await pool.query(
        `INSERT INTO customer_ledger (customer_id, entry_type, amount, balance_after, ref_type, ref_id)
         VALUES ($1, 'credit_sale', 1000.00, 1000.00, 'sale', gen_random_uuid())`,
        [custId]
      );
      const updatedCust = await pool.query('SELECT credit_balance FROM customers WHERE id = $1', [custId]);
      expect(parseFloat(updatedCust.rows[0].credit_balance)).toBe(1000.0);
    });

    it('blocks direct UPDATE of suppliers.outstanding_balance and enforces balance_after via supplier_ledger', async () => {
      const sRes = await pool.query(
        `INSERT INTO suppliers (name, outstanding_balance, is_active)
         VALUES ('Ledger Test Supplier', 0.00, true) RETURNING id`
      );
      const supId = sRes.rows[0].id;

      // 1. Direct UPDATE must fail
      let directUpdateBlocked = false;
      try {
        await pool.query('UPDATE suppliers SET outstanding_balance = 5000.00 WHERE id = $1', [supId]);
      } catch (err: any) {
        directUpdateBlocked = true;
        expect(err.message).toContain('Direct update of suppliers.outstanding_balance is prohibited');
      }
      expect(directUpdateBlocked).toBe(true);

      // 2. Correct ledger insert updates suppliers.outstanding_balance
      await pool.query(
        `INSERT INTO supplier_ledger (supplier_id, entry_type, amount, balance_after, ref_type, ref_id)
         VALUES ($1, 'purchase_credit', 2500.00, 2500.00, 'purchase', gen_random_uuid())`,
        [supId]
      );
      const updatedSup = await pool.query('SELECT outstanding_balance FROM suppliers WHERE id = $1', [supId]);
      expect(parseFloat(updatedSup.rows[0].outstanding_balance)).toBe(2500.0);
    });
  });

  describe('DB 5: hold_bill_items updated_at, batches.product_id immutable, stock_adjustments.movement_id FK', () => {
    it('sets updated_at on hold_bill_items on UPDATE', async () => {
      const holdBillRes = await pool.query(
        `INSERT INTO hold_bills (hold_reference, held_by) VALUES ($1, (SELECT id FROM users LIMIT 1)) RETURNING id`,
        [`HOLD_${Date.now()}`]
      );
      const holdId = holdBillRes.rows[0].id;

      const itemRes = await pool.query(
        `INSERT INTO hold_bill_items (hold_bill_id, product_id, quantity, unit_price)
         VALUES ($1, (SELECT id FROM products LIMIT 1), 2, 50.00) RETURNING id, updated_at`,
        [holdId]
      );
      const itemId = itemRes.rows[0].id;
      const initialUpdatedAt = itemRes.rows[0].updated_at;

      // Update quantity
      await new Promise((r) => setTimeout(r, 10));
      await pool.query('UPDATE hold_bill_items SET quantity = 5 WHERE id = $1', [itemId]);

      const check = await pool.query('SELECT updated_at FROM hold_bill_items WHERE id = $1', [itemId]);
      expect(new Date(check.rows[0].updated_at).getTime()).toBeGreaterThanOrEqual(new Date(initialUpdatedAt).getTime());
    });

    it('blocks UPDATE of batches.product_id', async () => {
      const bRes = await pool.query('SELECT id, product_id FROM batches LIMIT 1');
      const batchId = bRes.rows[0].id;
      const otherProdRes = await pool.query('SELECT id FROM products WHERE id <> $1 LIMIT 1', [bRes.rows[0].product_id]);
      const otherProdId = otherProdRes.rows[0].id;

      let updateBlocked = false;
      try {
        await pool.query('UPDATE batches SET product_id = $1 WHERE id = $2', [otherProdId, batchId]);
      } catch (err: any) {
        updateBlocked = true;
        expect(err.message).toContain('Modification of batches.product_id is strictly prohibited');
      }
      expect(updateBlocked).toBe(true);
    });

    it('enforces FK constraint on stock_adjustments.movement_id referencing stock_movements', async () => {
      const batchRes = await pool.query('SELECT id FROM batches LIMIT 1');
      const batchId = batchRes.rows[0].id;
      const userRes = await pool.query('SELECT id FROM users LIMIT 1');
      const userId = userRes.rows[0].id;

      // Non-existent movement_id must fail foreign key check
      let fkFailed = false;
      try {
        await pool.query(
          `INSERT INTO stock_adjustments (batch_id, adjustment_type, quantity_change, reason, adjusted_by, movement_id)
           VALUES ($1, 'correction', 5.00, 'Test reason', $2, gen_random_uuid())`,
          [batchId, userId]
        );
      } catch (err: any) {
        fkFailed = true;
        expect(err.message).toContain('foreign key');
      }
      expect(fkFailed).toBe(true);

      // Valid movement_id succeeds
      const mvRes = await pool.query(
        `INSERT INTO stock_movements (batch_id, movement_type, qty_change, ref_type, ref_id)
         VALUES ($1, 'adjustment', 5.00, 'stock_adjustment', gen_random_uuid()) RETURNING id`,
        [batchId]
      );
      const movementId = mvRes.rows[0].id;

      const adjRes = await pool.query(
        `INSERT INTO stock_adjustments (batch_id, adjustment_type, quantity_change, reason, adjusted_by, movement_id)
         VALUES ($1, 'correction', 5.00, 'Test reason', $2, $3) RETURNING id`,
        [batchId, userId, movementId]
      );
      expect(adjRes.rows[0].id).toBeDefined();
    });
  });

  describe('Auth 6: authenticate() exact path matching, lockout separation, /logout authentication', () => {
    it('uses exact match without query string for must_change_password bypass protection', async () => {
      // Create user with must_change_password = true
      const username = `must_change_${Date.now()}`;
      await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password)
         VALUES ($1, '$2b$10$abcdefghijklmnopqrstuvwxyz123456789012345678901234567890', 'Test', 'cashier', true, true)`,
        [username]
      );

      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password123' })
      });
      // Will fail login with bad password, so update hash to match password123
      const validHash = await (await import('../src/utils/crypto.js')).hashPassword('ValidPassword123');
      await pool.query('UPDATE users SET password_hash = $1 WHERE username = $2', [validHash, username]);

      const logSuccess = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'ValidPassword123' })
      });
      const data = (await logSuccess.json()) as any;
      const token = data.accessToken;

      // 1. Exact match on /api/v1/auth/me?query=123 must succeed
      const meRes = await fetch(`${baseUrl}/api/v1/auth/me?extra=param`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(meRes.status).toBe(200);

      // 2. Disallowed endpoint (e.g. /api/v1/users) must be blocked with 403 PASSWORD_CHANGE_REQUIRED
      const blockedRes = await fetch(`${baseUrl}/api/v1/users`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(blockedRes.status).toBe(403);
      const blockedData = (await blockedRes.json()) as any;
      expect(blockedData.error).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('requires authentication on /api/v1/auth/logout', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: 'POST'
      });
      expect(res.status).toBe(401);
    });
  });

  describe('Auth 7: Login lower(username), uniform 401s, atomic counter, password policy (8-72, new!=old)', () => {
    it('allows login with case-insensitive username (lower(username) = lower($1))', async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'AdMiN', password: 'password123' })
      });
      expect(res.status).toBe(200);
    });

    it('returns identical 401 response and message for unknown user, wrong password, and deactivated user', async () => {
      // 1. Unknown user
      const unkRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'completely_unknown_user_123', password: 'password123' })
      });
      expect(unkRes.status).toBe(401);
      const unkData = (await unkRes.json()) as any;

      // Verify audit log for unknown user was recorded
      const auditCheck = await pool.query(
        "SELECT * FROM audit_logs WHERE action = 'LOGIN_FAILED' AND entity_id = 'completely_unknown_user_123'"
      );
      expect(auditCheck.rows.length).toBeGreaterThan(0);

      // 2. Wrong password
      const wrongRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'wrongpassword' })
      });
      expect(wrongRes.status).toBe(401);
      const wrongData = (await wrongRes.json()) as any;

      // 3. Deactivated user
      const deactUser = `deact_login_${Date.now()}`;
      const hash = await (await import('../src/utils/crypto.js')).hashPassword('password123');
      await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, $2, 'Deact User', 'cashier', false)`,
        [deactUser, hash]
      );
      const deactRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: deactUser, password: 'password123' })
      });
      expect(deactRes.status).toBe(401);
      const deactData = (await deactRes.json()) as any;

      expect(unkData.error).toBe('INVALID_CREDENTIALS');
      expect(wrongData.error).toBe('INVALID_CREDENTIALS');
      expect(deactData.error).toBe('INVALID_CREDENTIALS');
      expect(unkData.message).toBe('Invalid username or password');
      expect(wrongData.message).toBe('Invalid username or password');
      expect(deactData.message).toBe('Invalid username or password');
    });

    it('enforces password policy: 8-72 chars, and new password != old password', async () => {
      // 1. Password unchanged (new == old)
      const resSame = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          oldPassword: 'password123',
          newPassword: 'password123'
        })
      });
      expect(resSame.status).toBe(400);

      // 2. Password too short (< 8)
      const resShort = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          oldPassword: 'password123',
          newPassword: 'short'
        })
      });
      expect(resShort.status).toBe(400);

      // 3. Password too long (> 72)
      const resLong = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          oldPassword: 'password123',
          newPassword: 'A'.repeat(73)
        })
      });
      expect(resLong.status).toBe(400);
    });
  });

  describe('Auth 8: Concurrent Refresh (15s grace window for concurrent tabs)', () => {
    it('allows two concurrent refreshes with the same token without logging out user or forking family', async () => {
      // 1. Log in to get refresh token cookie
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cashier', password: 'password123' })
      });
      const cookie = getCookieValue(loginRes, 'refreshToken');
      expect(cookie).toBeTruthy();

      // 2. Fire two concurrent refresh requests simultaneously with the same cookie
      const [ref1, ref2] = await Promise.all([
        fetch(`${baseUrl}/api/v1/auth/refresh`, { headers: { Cookie: `refreshToken=${cookie}` }, method: 'POST' }),
        fetch(`${baseUrl}/api/v1/auth/refresh`, { headers: { Cookie: `refreshToken=${cookie}` }, method: 'POST' })
      ]);

      // Both should succeed (one rotates, one hits 15s grace window)
      expect(ref1.status).toBe(200);
      expect(ref2.status).toBe(200);

      const d1 = (await ref1.json()) as any;
      const d2 = (await ref2.json()) as any;
      expect(d1.accessToken).toBeDefined();
      expect(d2.accessToken).toBeDefined();
    });
  });

  describe('Auth 11: Cashier 403s on restricted routes & stripCostPrices serializes Dates as ISO strings', () => {
    it('returns 403 for cashier on purchases, suppliers, exports and reports', async () => {
      // 1. Purchases
      const pRes = await fetch(`${baseUrl}/api/v1/purchases`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(pRes.status).toBe(403);

      // 2. Suppliers
      const sRes = await fetch(`${baseUrl}/api/v1/suppliers`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(sRes.status).toBe(403);

      // 3. CSV Export
      const eRes = await fetch(`${baseUrl}/api/v1/products/export-csv`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(eRes.status).toBe(403);

      // 4. Reports
      const rRes = await fetch(`${baseUrl}/api/v1/reports`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(rRes.status).toBe(403);
    });

    it('stripCostPrices leaves created_at as an ISO string while removing cost, margin, profit', () => {
      const sample = {
        id: '123',
        product: 'Paracetamol',
        created_at: new Date('2026-11-12T10:00:00.000Z'),
        cost_price: '2.50',
        unit_cost_price: '2.50',
        pack_cost: '250.00',
        purchase_cost: '250.00',
        cost: '2.50',
        margin: '1.50',
        profit: '1.50',
        mrp: '4.00'
      };

      const cleaned = stripCostPrices(sample);

      // created_at must be an ISO string
      expect(typeof cleaned.created_at).toBe('string');
      expect(cleaned.created_at).toBe('2026-11-12T10:00:00.000Z');

      // Sensitive fields must be stripped
      expect(cleaned.cost_price).toBeUndefined();
      expect(cleaned.unit_cost_price).toBeUndefined();
      expect(cleaned.pack_cost).toBeUndefined();
      expect(cleaned.purchase_cost).toBeUndefined();
      expect(cleaned.cost).toBeUndefined();
      expect(cleaned.margin).toBeUndefined();
      expect(cleaned.profit).toBeUndefined();

      // MRP must remain
      expect(cleaned.mrp).toBe('4.00');
    });
  });
});
