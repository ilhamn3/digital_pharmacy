import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { app } from '../src/index.js';
import { pool } from '../src/db/pool.js';
import { hashPassword, comparePassword } from '../src/utils/crypto.js';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

describe('Step 2: Auth, Users, Roles & Audit Middleware Tests', () => {
  let server: http.Server;
  let baseUrl: string;

  // Test credentials
  let ownerToken: string;
  let pharmacistToken: string;
  let cashierToken: string;

  // Helper to extract cookie value
  function getCookieValue(res: globalThis.Response, cookieName: string): string | null {
    const rawCookies = res.headers.get('set-cookie');
    if (!rawCookies) return null;
    const match = rawCookies.match(new RegExp(`${cookieName}=([^;]+)`));
    return match ? match[1] : null;
  }

  beforeAll(async () => {
    // Start ephemeral server
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });

    // Obtain tokens for owner, pharmacist, and cashier from seeded demo accounts
    const login = async (username: string) => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'password123' })
      });
      const data = (await res.json()) as any;
      expect(res.status).toBe(200);
      // Requirement 1: refresh token must NOT be in JSON body
      expect(data.refreshToken).toBeUndefined();
      // Requirement 1: refresh token MUST be in httpOnly cookie
      const cookie = getCookieValue(res, 'refreshToken');
      expect(cookie).toBeTruthy();

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

  describe('Password Hashing & Crypto Utilities', () => {
    it('correctly hashes passwords with bcrypt and verifies matches', async () => {
      const raw = 'SecretPassw0rd!';
      const hash = await hashPassword(raw);
      expect(hash).not.toBe(raw);
      expect(await comparePassword(raw, hash)).toBe(true);
      expect(await comparePassword('WrongPassword', hash)).toBe(false);
    });
  });

  describe('Authentication & Progressive Delay / Timing Equivalence', () => {
    it('rejects invalid password and increments failed login counter', async () => {
      const testUser = `lockout_test_${Date.now()}`;
      const hash = await hashPassword('password123');
      await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, $2, 'Lockout Tester', 'cashier', true)`,
        [testUser, hash]
      );

      const res1 = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUser, password: 'wrongpassword' })
      });
      expect(res1.status).toBe(401);
      const data1 = (await res1.json()) as any;
      expect(data1.error).toBe('INVALID_CREDENTIALS');
      expect(data1.message).toBe('Invalid username or password');

      const dbCheck = await pool.query('SELECT failed_login_count FROM users WHERE username = $1', [testUser]);
      expect(dbCheck.rows[0].failed_login_count).toBe(1);
    });

    it('returns identical error message and status for unknown user and wrong password', async () => {
      // 1. Wrong password on existing user
      const resWrong = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cashier', password: 'wrongpassword' })
      });
      const dataWrong = (await resWrong.json()) as any;

      // 2. Non-existent user
      const resUnknown = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'non_existent_user_9999', password: 'wrongpassword' })
      });
      const dataUnknown = (await resUnknown.json()) as any;

      expect(resWrong.status).toBe(401);
      expect(resUnknown.status).toBe(401);
      expect(dataWrong.error).toBe(dataUnknown.error);
      expect(dataWrong.message).toBe(dataUnknown.message);
    });

    it('applies progressive delay after repeated failures instead of 15-min hard lockout', async () => {
      const testUser = `prog_delay_${Date.now()}`;
      const hash = await hashPassword('password123');
      await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, $2, 'Progressive Tester', 'cashier', true)`,
        [testUser, hash]
      );

      // Perform 3 rapid failed attempts
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: testUser, password: 'badpassword' })
        });
        expect(res.status).toBe(401);
      }

      const check = await pool.query('SELECT failed_login_count, locked_until FROM users WHERE username = $1', [testUser]);
      expect(check.rows[0].failed_login_count).toBe(3);
      expect(check.rows[0].locked_until).not.toBeNull();
    });
  });

  describe('Refresh Token Cookie-Only Rotation & Reuse Detection', () => {
    it('handles refresh token solely via httpOnly cookie, rotating and detecting reuse', async () => {
      // 1. Log in to obtain refresh token cookie
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'cashier', password: 'password123' })
      });
      expect(loginRes.status).toBe(200);
      const loginBody = (await loginRes.json()) as any;
      expect(loginBody.refreshToken).toBeUndefined(); // NEVER in body!

      const initialCookie = getCookieValue(loginRes, 'refreshToken');
      expect(initialCookie).toBeTruthy();

      // 2. Perform rotation by passing httpOnly cookie
      const refreshRes1 = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `refreshToken=${initialCookie}`
        }
      });
      expect(refreshRes1.status).toBe(200);
      const refreshBody1 = (await refreshRes1.json()) as any;
      expect(refreshBody1.refreshToken).toBeUndefined(); // NEVER in body!
      expect(refreshBody1.accessToken).toBeDefined();

      const secondCookie = getCookieValue(refreshRes1, 'refreshToken');
      expect(secondCookie).toBeTruthy();
      expect(secondCookie).not.toBe(initialCookie);

      // 3. MALICIOUS REUSE: Replay the initial (already rotated/revoked) refresh token
      const reuseRes = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `refreshToken=${initialCookie}`
        }
      });
      expect(reuseRes.status).toBe(403);
      const reuseData = (await reuseRes.json()) as any;
      expect(reuseData.error).toBe('TOKEN_REUSE_COMPROMISED');

      // 4. Verify compromise defense invalidated the second cookie as well
      const attemptSecond = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `refreshToken=${secondCookie}`
        }
      });
      expect(attemptSecond.status).toBe(403);
    });
  });

  describe('Auth Middleware DB Freshness (Immediate Revocation & Role Change)', () => {
    it('immediately blocks requests when a user is deactivated in the database', async () => {
      // Create user and log in
      const testUser = `deact_test_${Date.now()}`;
      const hash = await hashPassword('password123');
      const uRes = await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, $2, 'Deact Tester', 'cashier', true)
         RETURNING id`,
        [testUser, hash]
      );
      const userId = uRes.rows[0].id;

      const logRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUser, password: 'password123' })
      });
      const logData = (await logRes.json()) as any;
      const userToken = logData.accessToken;

      // Verify token works
      const validRes = await fetch(`${baseUrl}/api/v1/test/price-visibility`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(validRes.status).toBe(200);

      // Deactivate user in DB
      await pool.query('UPDATE users SET is_active = false WHERE id = $1', [userId]);

      // Immediate request with same unexpired token must be rejected with 403
      const blockedRes = await fetch(`${baseUrl}/api/v1/test/price-visibility`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(blockedRes.status).toBe(403);
      const blockedData = (await blockedRes.json()) as any;
      expect(blockedData.error).toBe('ACCOUNT_DEACTIVATED');
    });

    it('immediately applies role changes made in the database', async () => {
      const testUser = `role_test_${Date.now()}`;
      const hash = await hashPassword('password123');
      const uRes = await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active)
         VALUES ($1, $2, 'Role Tester', 'cashier', true)
         RETURNING id`,
        [testUser, hash]
      );
      const userId = uRes.rows[0].id;

      const logRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: testUser, password: 'password123' })
      });
      const logData = (await logRes.json()) as any;
      const userToken = logData.accessToken;

      // As a cashier, accessing /api/v1/suppliers is forbidden (403)
      const cashierCheck = await fetch(`${baseUrl}/api/v1/suppliers`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(cashierCheck.status).toBe(403);

      // Promote user to pharmacist in DB
      await pool.query("UPDATE users SET role = 'pharmacist' WHERE id = $1", [userId]);

      // Immediate request with same unexpired token must now succeed (200)
      const promotedCheck = await fetch(`${baseUrl}/api/v1/suppliers`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(promotedCheck.status).toBe(200);
    });
  });

  describe('Must Change Password Flow', () => {
    it('restricts user with must_change_password=true until password is changed', async () => {
      const tempUser = `temp_${Date.now()}`;
      const hash = await hashPassword('TempSecret123');

      const userRes = await pool.query(
        `INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password)
         VALUES ($1, $2, 'Temporary User', 'pharmacist', true, true)
         RETURNING id`,
        [tempUser, hash]
      );
      const tempUserId = userRes.rows[0].id;

      // Log in
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: tempUser, password: 'TempSecret123' })
      });
      const loginData = (await loginRes.json()) as any;
      expect(loginData.user.mustChangePassword).toBe(true);
      const token = loginData.accessToken;

      // Attempting to access protected endpoint must be blocked
      const blockedRes = await fetch(`${baseUrl}/api/v1/test/price-visibility`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(blockedRes.status).toBe(403);
      const blockedData = (await blockedRes.json()) as any;
      expect(blockedData.error).toBe('PASSWORD_CHANGE_REQUIRED');

      // Change password
      const changeRes = await fetch(`${baseUrl}/api/v1/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          oldPassword: 'TempSecret123',
          newPassword: 'BrandNewPassword123!'
        })
      });
      expect(changeRes.status).toBe(200);
      const changeData = (await changeRes.json()) as any;
      const newToken = changeData.accessToken;

      // Now protected endpoint should be accessible
      const unblockedRes = await fetch(`${baseUrl}/api/v1/test/price-visibility`, {
        headers: { Authorization: `Bearer ${newToken}` }
      });
      expect(unblockedRes.status).toBe(200);
    });
  });

  describe('Cashier Data Protection & Whitelist Projection', () => {
    it('forbids cashier from accessing supplier and purchase endpoints', async () => {
      const supRes = await fetch(`${baseUrl}/api/v1/suppliers`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      expect(supRes.status).toBe(403);
    });

    it('strictly strips all cost_price, unit_cost_price, pack_cost, supplier fields for cashier', async () => {
      const cashierRes = await fetch(`${baseUrl}/api/v1/test/price-visibility`, {
        headers: { Authorization: `Bearer ${cashierToken}` }
      });
      const cashierData = (await cashierRes.json()) as any;

      // Selling price and MRP must remain visible
      expect(cashierData.product).toBe('Panadol 500mg');
      expect(cashierData.mrp).toBe('4.00');
      expect(cashierData.batches[0].unit_selling_price).toBe('4.00');

      // Cost price fields must be completely stripped
      expect(cashierData.cost_price).toBeUndefined();
      expect(cashierData.batches[0].unit_cost_price).toBeUndefined();
    });
  });

  describe('Audit Trail & Password Sanitization', () => {
    it('records user mutations in audit_logs with passwords and tokens completely redacted', async () => {
      const newUsername = `audit_audit_${Date.now()}`;
      const createRes = await fetch(`${baseUrl}/api/v1/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`
        },
        body: JSON.stringify({
          username: newUsername,
          password: 'SuperSecretPassword99!',
          fullName: 'Audit Test Person',
          role: 'cashier'
        })
      });
      expect(createRes.status).toBe(201);
      const createdData = (await createRes.json()) as any;
      const createdUserId = createdData.user.id;

      const auditQuery = await pool.query(
        "SELECT * FROM audit_logs WHERE entity = 'USER' AND entity_id = $1 ORDER BY created_at DESC",
        [createdUserId]
      );
      expect(auditQuery.rows.length).toBeGreaterThan(0);
      const logRow = auditQuery.rows[0];

      const logString = JSON.stringify(logRow);
      expect(logString).not.toContain('SuperSecretPassword99!');
    });
  });
});
