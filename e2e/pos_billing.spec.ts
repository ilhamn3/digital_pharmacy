import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DOCS_STEP6_DIR = path.resolve('docs/step6');
const ARTIFACT_DIR = 'C:/Users/ilham/.gemini/antigravity/brain/f60a89bf-ee16-4c03-bfc3-e45d83179c87';

// Ensure docs/step6 directory exists
if (!fs.existsSync(DOCS_STEP6_DIR)) {
  fs.mkdirSync(DOCS_STEP6_DIR, { recursive: true });
}

/**
 * Saves screenshot to both docs/step6/ and brain artifact directory
 */
async function saveScreenshot(page: Page, filename: string) {
  const targetPath = path.join(DOCS_STEP6_DIR, filename);
  await page.screenshot({ path: targetPath });
  if (fs.existsSync(ARTIFACT_DIR)) {
    try {
      fs.copyFileSync(targetPath, path.join(ARTIFACT_DIR, filename));
    } catch (e) {
      console.warn(`Could not copy screenshot to artifact dir:`, e);
    }
  }
}

/**
 * Helper to log in with clean session state
 */
async function loginAs(page: Page, username: string, password = 'password123') {
  await page.goto('/');
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  await page.goto('/');
  await expect(page.getByText('Lanka Health Pharmacy')).toBeVisible();
  await page.fill('input[placeholder*="cashier"]', username);
  await page.fill('input[placeholder="••••••••"]', password);
  await page.click('button:has-text("Sign In")');
  await expect(page.getByText('POS Billing')).toBeVisible();
}

/**
 * Key scanner for detecting data leakage in JSON responses
 */
const SENSITIVE_REGEX = /(cost|margin|profit|supplier|purchase)/i;
const SENSITIVE_EXACT = new Set([
  'cost_price',
  'costprice',
  'unit_cost',
  'unitcost',
  'unit_cost_price',
  'unitcostprice',
  'pack_cost',
  'packcost',
  'purchase_cost',
  'purchasecost'
]);

function findSensitiveKeys(obj: any, currentPath = ''): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const found: string[] = [];
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      found.push(...findSensitiveKeys(item, `${currentPath}[${idx}]`));
    });
  } else {
    for (const [key, val] of Object.entries(obj)) {
      const fullPath = currentPath ? `${currentPath}.${key}` : key;
      const lower = key.toLowerCase();
      if (SENSITIVE_EXACT.has(lower) || SENSITIVE_REGEX.test(key)) {
        found.push(fullPath);
      }
      if (val && typeof val === 'object') {
        found.push(...findSensitiveKeys(val, fullPath));
      }
    }
  }
  return found;
}

test.describe('POS Billing Step 6 Hardened End-to-End Test Suite', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('BROWSER ERROR LOG:', msg.text());
      }
    });
  });

  // 1. Full Cash Checkout
  test('E2E-1: scan -> cart -> cash pay -> thermal 80mm receipt', async ({ page }) => {
    await loginAs(page, 'cashier');

    // 1. Verify POS screen loaded and capture pos_screen.png
    await expect(page.getByText('POS Billing')).toBeVisible();
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await expect(searchInput).toBeVisible();
    await saveScreenshot(page, 'pos_screen.png');

    // 2. Search and add product
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // 3. Verify Cart table populated
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(page.getByText('Panadol 500mg')).toBeVisible();
    await expect(page.getByText('Total Amount')).toBeVisible();

    // 4. Trigger Payment Dialog (F9)
    const payBtn = page.getByRole('button', { name: /Pay \/ Checkout/i });
    await expect(payBtn).toBeEnabled();
    await payBtn.click();

    // 5. Verify Payment Dialog and capture payment_dialog.png
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();
    await expect(page.getByText('Cash Tendered')).toBeVisible();
    await saveScreenshot(page, 'payment_dialog.png');

    // 6. Complete Cash Checkout
    const confirmBtn = page.getByRole('button', { name: /Confirm & Print Receipt/i });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // 7. Verify Receipt Modal & thermal print area and capture receipt.png
    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#receipt-print-area')).toBeVisible();
    await expect(page.locator('text=INV-')).toBeVisible();
    await saveScreenshot(page, 'receipt.png');

    // 8. Close receipt modal and assert cart cleared
    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();
    await expect(page.getByText('Cart is currently empty')).toBeVisible();
  });

  // 2. Network-level Cashier data leakage protection vs Owner
  test('E2E-2: Cashier data leakage protection at network level vs Owner', async ({ page, request }) => {
    const interceptedCashierPayloads: { url: string; data: any }[] = [];

    // Intercept all API responses during cashier session
    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('/api/v1/') && !url.includes('/auth/login') && !url.includes('/auth/refresh')) {
        try {
          const contentType = res.headers()['content-type'] || '';
          if (contentType.includes('application/json')) {
            const json = await res.json();
            interceptedCashierPayloads.push({ url, data: json });
          }
        } catch {
          // ignore non-json responses
        }
      }
    });

    await loginAs(page, 'cashier');

    // Exercise cashier endpoints: search product, get product details, view customers, hold bills, sales list
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // Open Customer Dialog (loads /customers)
    await page.click('button:has-text("Select Customer")');
    await expect(page.getByText('Customer Selection')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Customer Selection')).not.toBeVisible();

    // Open Hold Bills Dialog (loads /hold-bills)
    await page.click('button:has-text("Hold Bill (F8)")');
    await expect(page.getByText('Held Bills')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText('Held Bills')).not.toBeVisible();

    // Open Sales History tab (loads /sales)
    await page.click('button:has-text("Sales History")');
    await expect(page.getByText('Sales Transactions')).toBeVisible();

    // Assert that across all intercepted cashier responses, ZERO sensitive keys exist!
    expect(interceptedCashierPayloads.length).toBeGreaterThan(0);
    const leakedKeys: string[] = [];
    for (const item of interceptedCashierPayloads) {
      const sensitive = findSensitiveKeys(item.data);
      if (sensitive.length > 0) {
        leakedKeys.push(`${item.url} -> ${sensitive.join(', ')}`);
      }
    }
    expect(leakedKeys).toEqual([]); // Zero sensitive leaks for cashier!

    // NOW PROVE SCANNER WORKS: fetch product details as owner / admin via API and confirm it DOES have sensitive keys
    const loginRes = await request.post('http://localhost:4000/api/v1/auth/login', {
      data: { username: 'admin', password: 'password123' }
    });
    expect(loginRes.ok()).toBe(true);
    const loginData = await loginRes.json();
    const ownerToken = loginData.accessToken;

    // Search product as owner
    const prodSearchRes = await request.get('http://localhost:4000/api/v1/products?search=Panadol', {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const prodSearchJson = await prodSearchRes.json();
    const prodId = prodSearchJson.products[0].id;

    // Get product details as owner
    const prodDetailRes = await request.get(`http://localhost:4000/api/v1/products/${prodId}`, {
      headers: { Authorization: `Bearer ${ownerToken}` }
    });
    const prodDetailJson = await prodDetailRes.json();

    const ownerSensitive = findSensitiveKeys(prodDetailJson);
    expect(ownerSensitive.length).toBeGreaterThan(0);
    expect(ownerSensitive.some((k) => k.toLowerCase().includes('costprice'))).toBe(true);
  });

  // 3. Store Credit Tender with Customer & Ledger Invariant
  test('E2E-3: Store Credit sale with Customer and Ledger Check', async ({ page }) => {
    let capturedCheckoutPayload: any = null;

    // Intercept checkout POST to verify payload invariant
    await page.route('**/api/v1/sales', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        capturedCheckoutPayload = JSON.parse(req.postData() || '{}');
      }
      await route.continue();
    });

    await loginAs(page, 'cashier');

    // 1. Select Customer "Sunil Perera"
    await page.click('button:has-text("Select Customer")');
    await expect(page.getByText('Customer Selection')).toBeVisible();
    await page.click('text=Sunil Perera');
    await expect(page.getByText('Customer Selection')).not.toBeVisible();
    await expect(page.locator('body')).toContainText('Sunil Perera');

    // 2. Add product to cart
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // 3. Open Payment Dialog (F9)
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();

    // 4. Select Credit payment mode
    await page.click('button:has-text("Credit")');
    await expect(page.getByText('Full Credit Sale')).toBeVisible();
    await saveScreenshot(page, 'credit_sale.png');

    // 5. Confirm checkout
    await page.click('button:has-text("Confirm & Print Receipt")');

    // 6. Verify receipt shows Customer, Balance Due, and receipt details
    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    const receiptText = await page.locator('#receipt-print-area').innerText();
    expect(receiptText).toContain('Sunil Perera');
    expect(receiptText).toContain('Balance Due:');
    expect(receiptText).toContain('Rs. 4.00');

    // 7. Assert checkout payload invariants:
    // Store Credit must NEVER be sent as a payments row!
    expect(capturedCheckoutPayload).not.toBeNull();
    expect(capturedCheckoutPayload.payments).toEqual([]);
    expect(capturedCheckoutPayload.customerId).toBeDefined();
    expect(capturedCheckoutPayload.idempotencyKey).toBeDefined();

    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();
  });

  // 4. Split Payment (Cash + Card)
  test('E2E-4: Split Payment (Cash + Card)', async ({ page }) => {
    let capturedCheckoutPayload: any = null;

    await page.route('**/api/v1/sales', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        capturedCheckoutPayload = JSON.parse(req.postData() || '{}');
      }
      await route.continue();
    });

    await loginAs(page, 'cashier');

    // Ensure cart is clear
    const clearBtn = page.getByRole('button', { name: /Clear Cart/i });
    if (await clearBtn.isEnabled()) {
      await clearBtn.click();
    }
    await expect(page.getByText('Cart is currently empty')).toBeVisible();

    // Select Customer Sunil Perera
    await page.click('button:has-text("Select Customer")');
    await expect(page.getByText('Customer Selection')).toBeVisible();
    await page.click('text=Sunil Perera');
    await expect(page.getByText('Customer Selection')).not.toBeVisible();

    // Add Panadol (total = Rs. 4.00)
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('tbody tr')).toHaveCount(1);

    // Open Payment Dialog
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();

    // Switch to Split / Partial Payment
    await page.click('button:has-text("Split / Partial Payment")');
    await expect(page.getByText('Split Payment Breakdown')).toBeVisible();

    // Cash portion: Rs. 2.00
    const cashInput = page.locator('[data-testid="split-amount-0"]');
    await cashInput.fill('2');

    // Add Card method: Rs. 2.00
    await page.click('button:has-text("+ Add Another Payment Method")');
    await page.locator('[data-testid="split-method-1"]').selectOption('card');
    await page.locator('[data-testid="split-amount-1"]').fill('2');

    await saveScreenshot(page, 'split_payment.png');

    // Submit checkout
    await page.click('button:has-text("Confirm & Print Receipt")');

    // Verify receipt modal
    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    const receiptText = await page.locator('#receipt-print-area').innerText();
    expect(receiptText).toContain('Cash:');
    expect(receiptText).toContain('Card:');
    expect(receiptText).toContain('Rs. 4.00');

    // Assert checkout payload has both real tenders
    expect(capturedCheckoutPayload).not.toBeNull();
    expect(capturedCheckoutPayload.payments.length).toBe(2);
    expect(capturedCheckoutPayload.payments[0].type).toBe('cash');
    expect(capturedCheckoutPayload.payments[0].amount).toBe(2);
    expect(capturedCheckoutPayload.payments[1].type).toBe('card');
    expect(capturedCheckoutPayload.payments[1].amount).toBe(2);

    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();
  });

  // 5. Sales History Void & Stock Restore
  test('E2E-5: Sales History Void & Stock Restore', async ({ page, request }) => {
    // Login as pharmacist (has void permission)
    await loginAs(page, 'pharmacist');

    // Query initial stock via API
    const loginRes = await request.post('http://localhost:4000/api/v1/auth/login', {
      data: { username: 'pharmacist', password: 'password123' }
    });
    const loginData = await loginRes.json();
    const token = loginData.accessToken;
    const prodResBefore = await request.get('http://localhost:4000/api/v1/products?search=Panadol', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const stockBefore = (await prodResBefore.json()).products[0].totalStock;

    // Add product and checkout
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();
    await page.click('button:has-text("Confirm & Print Receipt")');

    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    const billNoMatch = (await page.locator('#receipt-print-area').innerText()).match(/INV-\d+-\d+/);
    const billNo = billNoMatch ? billNoMatch[0] : '';
    expect(billNo.length).toBeGreaterThan(0);

    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();

    // Verify stock decremented by 1
    const prodResAfterSale = await request.get('http://localhost:4000/api/v1/products?search=Panadol', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const stockAfterSale = (await prodResAfterSale.json()).products[0].totalStock;
    expect(Number(stockAfterSale)).toBe(Number(stockBefore) - 1);

    // Switch to Sales History tab
    await page.click('button:has-text("Sales History")');
    await expect(page.getByText('Sales Transactions')).toBeVisible();

    // Find the row for this bill
    const saleRow = page.locator(`tr:has-text("${billNo}")`);
    await expect(saleRow).toBeVisible();

    // Click Void button
    const voidBtn = saleRow.locator('button:has-text("Void")');
    await expect(voidBtn).toBeVisible();
    await voidBtn.click();

    // Void confirmation modal opens
    await expect(page.getByText('Void Sale Confirmation')).toBeVisible();
    await saveScreenshot(page, 'sales_history_void.png');

    // Fill void reason
    await page.fill('textarea[placeholder*="Billing error"]', 'Customer cancellation - defective packaging');
    await page.click('button:has-text("Confirm Void Sale")');

    // Verify modal closes and row badge updates to VOIDED
    await expect(page.getByText('Void Sale Confirmation')).not.toBeVisible();
    await expect(saleRow.locator('text=VOIDED')).toBeVisible();

    // Verify stock restored back to initial stock!
    const prodResAfterVoid = await request.get('http://localhost:4000/api/v1/products?search=Panadol', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const stockAfterVoid = (await prodResAfterVoid.json()).products[0].totalStock;
    expect(Number(stockAfterVoid)).toBe(Number(stockBefore));
  });

  // 6. Rx Flow as Pharmacist
  test('E2E-6: Rx Flow as Pharmacist', async ({ page }) => {
    await loginAs(page, 'pharmacist');

    // Search and add Rx product: "Amoxicillin 250mg DT"
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Amoxicillin');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // Verify Rx badge in cart table
    await expect(page.getByText('Amoxicillin 250mg DT')).toBeVisible();
    await expect(page.locator('table span:has-text("Rx")')).toBeVisible();

    // Click Pay -> Opens Rx Modal
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Prescription (Rx) Verification')).toBeVisible();
    await saveScreenshot(page, 'rx_modal.png');

    // Fill Doctor and Patient
    await page.fill('input[placeholder*="Dr. K. Fernando"]', 'Dr. K. Fernando');
    await page.fill('input[placeholder*="Nimal Perera"]', 'Kamal Perera');

    // Confirm Rx Details -> Opens Payment Dialog
    await page.click('button:has-text("Confirm Rx Details")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();

    // Complete checkout
    await page.click('button:has-text("Confirm & Print Receipt")');

    // Verify receipt modal contains Doctor & Patient
    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    const receiptText = await page.locator('#receipt-print-area').innerText();
    expect(receiptText).toContain('Dr. K. Fernando');
    expect(receiptText).toContain('Kamal Perera');

    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();
  });

  // 7. Cashier Rx Blocked
  test('E2E-7: Cashier Rx Blocked (Pharmacist or Owner Required)', async ({ page }) => {
    await loginAs(page, 'cashier');

    // Search and add Rx product: "Amoxicillin 250mg DT"
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Amoxicillin');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // Click Pay -> Opens Rx Modal
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Prescription (Rx) Verification')).toBeVisible();

    // Verify Pharmacist or Owner Required warning is shown
    await expect(page.getByText(/Pharmacist or Owner Required/i)).toBeVisible();
    await expect(page.getByText(/RX_DISPENSING_RESTRICTED/i)).toBeVisible();

    // Doctor & Patient inputs must be disabled
    const docInput = page.locator('input[placeholder*="Dr. K. Fernando"]');
    const patInput = page.locator('input[placeholder*="Nimal Perera"]');
    await expect(docInput).toBeDisabled();
    await expect(patInput).toBeDisabled();

    // Confirm button must be disabled
    const confirmBtn = page.getByRole('button', { name: /Confirm Rx Details/i });
    await expect(confirmBtn).toBeDisabled();

    // Cashier cancels
    await page.click('button:has-text("Cancel")');
    await expect(page.getByText('Prescription (Rx) Verification')).not.toBeVisible();
    await expect(page.getByText('Amoxicillin 250mg DT')).toBeVisible();
  });

  // 8. Idempotency Key Persistence across Page Reload
  test('E2E-8: Idempotency Key Persistence across Page Reload', async ({ page }) => {
    await loginAs(page, 'cashier');

    // Add Panadol to cart
    const searchInput = page.locator('input[placeholder*="Scan barcode"]');
    await searchInput.fill('Panadol');
    const option = page.locator('li[role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();

    // Open Payment Dialog (this initializes and persists the idempotencyKey in sessionStorage)
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();

    // Extract idempotency key from sessionStorage before reload
    const keyBefore = await page.evaluate(() => {
      const stored = JSON.parse(sessionStorage.getItem('lanka_pharmacy_pos_cart_v1') || '{}');
      return stored.idempotencyKey;
    });

    expect(keyBefore).toBeDefined();
    expect(typeof keyBefore).toBe('string');
    expect(keyBefore.length).toBeGreaterThan(20);

    // Reload the page
    await page.reload();

    // Verify cart was restored from sessionStorage
    await expect(page.getByText('Panadol 500mg')).toBeVisible();

    // Extract idempotency key after reload
    const keyAfter = await page.evaluate(() => {
      const stored = JSON.parse(sessionStorage.getItem('lanka_pharmacy_pos_cart_v1') || '{}');
      return stored.idempotencyKey;
    });

    // Invariant: key MUST persist and be strictly equal across reloads!
    expect(keyAfter).toBe(keyBefore);

    // Open Payment dialog and complete payment
    await page.click('button:has-text("Pay / Checkout")');
    await expect(page.getByText('Finalize Sale & Payment')).toBeVisible();
    await page.click('button:has-text("Confirm & Print Receipt")');

    await expect(page.getByText('Receipt Preview')).toBeVisible({ timeout: 15000 });
    await page.click('button:has-text("Done / Next Sale")');
    await expect(page.getByText('Receipt Preview')).not.toBeVisible();
  });
});
