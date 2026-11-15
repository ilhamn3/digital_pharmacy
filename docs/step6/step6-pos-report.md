# Step 6 POS Billing UI Hardening Report

**Branch:** `phase1/step-6-pos-ui`  
**Date:** 2026-11-15  
**Database:** PostgreSQL 16 (Container `pharmacy_postgres` on Port 5433, Database `pharmacy_test`)  
**Backend Status:** Step 5 Backend & Migrations 001–008 are **strictly frozen** (0 schema or API route modifications).

---

## 1. Executive Summary & Verification Metrics

All 10 hardening items have been comprehensively verified, tested, and documented. The test suite execution results across backend, frontend unit, and browser end-to-end (E2E) suites are completely green:

| Test Suite | Spec Files | Tests Run | Result | Key Invariants Asserted |
|---|---|---|---|---|
| **Backend Integration** | 7 files | 152 | **152 Passed (100%)** | Concurrency, row locking, FEFO allocation, stock movements triggers, audit trails, bill numbering, void rules |
| **Frontend Unit & Component** | 7 files | 23 | **23 Passed (100%)** | `decimal.js` preview math, role discount limits (cashier 5%, pharmacist 15%, owner 100%), Rx modal role enforcement, storage security audit, idempotency persistence, store credit tender rules |
| **Playwright E2E Browser** | 1 file (8 scenarios) | 8 | **8 Passed (100%)** | Cash checkout, cashier network data scanner, store credit ledger, split cash+card, sales void & stock restore, pharmacist Rx verification, cashier Rx block, reload idempotency |
| **Production Web Build** | Vite + Rollup | Code-split | **81.15 kB gzipped** | Main bundle is **81.15 kB** (well under the 250 kB limit); secondary views dynamically code-split |

---

## 2. Comprehensive Item-by-Item Verification

### Item 1: Store Credit Tender Mechanics & Customer Requirement
- **Requirement**: Credit must never be sent as a payments row. Client sends only real tenders (`cash`, `card`, `bank_transfer`). Server derives `balance_due` and customer ledger entry. Credit/partial sale requires a selected registered customer.
- **Implementation**:
  - `PaymentDialog.tsx`: `finalPayments = splitPayments.filter((p) => p.type !== 'credit' && Number(p.amount) > 0)`
  - Single credit mode sends `payments: []`.
  - Blocks submission with error message if `balanceDue > 0` and customer is missing.
- **Tests & Assertions**:
  1. `apps/web/src/test/creditTender.test.tsx` -> `blocks credit sale when walk-in customer is selected (no customer)`
     - *Asserts*: Selecting credit mode with walk-in customer disables checkout button and displays error: *"A registered customer is required for credit / partial balance sales."*
  2. `apps/web/src/test/creditTender.test.tsx` -> `sends ZERO payment rows in request body for full Store Credit sale, deriving balanceDue on server`
     - *Asserts*: Request body payload contains `payments: []`, `customerId: "cust-123"`. Resulting sale has `balanceDue: 4.00`.
  3. `apps/web/src/test/creditTender.test.tsx` -> `sends only real tenders (cash) in partial payment sale, with zero credit rows and correct balance_due`
     - *Asserts*: Request body payload contains `payments: [{ type: 'cash', amount: 2 }]`. Credit rows are absent.
  4. `e2e/pos_billing.spec.ts` -> `E2E-3: Store Credit sale with Customer and Ledger Check`
     - *Asserts*: Intercepted checkout POST contains `payments: []`. Printed thermal receipt shows customer name `"Sunil Perera"`, `"Balance Due: Rs. 4.00"`.

---

### Item 2: Idempotency Key Persistence & Retry Safety
- **Requirement**: Persist checkout idempotency key together with the cart in `sessionStorage`. Reuse the same key across retries, network errors, timeouts, or page reloads. Invalidate/regenerate only when cart contents change. Handle 409 conflict.
- **Implementation**:
  - `PosContext.tsx`: `getOrCreateIdempotencyKey()` creates a UUID and stores it in context and `sessionStorage`. Any addition, removal, or quantity adjustment calls `invalidateIdempotencyKey()`.
  - `PaymentDialog.tsx`: Uses `getOrCreateIdempotencyKey()`. Catches 409 and prompts cashier to review cart without double billing.
- **Tests & Assertions**:
  1. `apps/web/src/test/idempotency.test.tsx` -> `generates consistent idempotency key and reuses the exact same key on retry after network/server error`
     - *Asserts*: Initial POST fails with 500/network error. Clicking "Retry Checkout" makes a second POST with the exact same `idempotencyKey` UUID.
  2. `apps/web/src/test/idempotency.test.tsx` -> `persists idempotencyKey in sessionStorage and reuses it on page reload`
     - *Asserts*: Key is preserved across reload if cart has not changed. Modifying quantity generates a new distinct key.
  3. `apps/web/src/test/idempotency.test.tsx` -> `handles 409 IDEMPOTENCY_CONFLICT with clear message and requires cashier to review cart before generating new key`
     - *Asserts*: Displays conflict banner: *"Transaction conflict: This idempotency key was previously submitted with different cart details."*
  4. `e2e/pos_billing.spec.ts` -> `E2E-8: Idempotency Key Persistence across Page Reload`
     - *Asserts*: In a real browser, cart items and idempotency key match across page reload.

---

### Item 3: Cashier Network-Level Data Leakage Protection
- **Requirement**: Cashier must never see cost, margin, profit, or supplier. Recursively inspect all cashier API responses across search, details, customers, hold bills, and sales history. Compare with owner responses to prove scanner efficacy.
- **Implementation**:
  - Backend whitelist DTOs and database scrubber ensure cashiers receive 403 on purchases/suppliers and scrubbed columns on product/sales.
  - Playwright test recursively traverses every key in every intercepted cashier JSON response.
- **Tests & Assertions**:
  1. `e2e/pos_billing.spec.ts` -> `E2E-2: Cashier data leakage protection at network level vs Owner`
     - *Asserts*: Cashier intercepts over all product searches, customer dialogs, hold bills, and sales endpoints contain **0 leaked keys** matching `/(cost|margin|profit|supplier|purchase)/i` or exact keys (`cost_price`, `pack_cost`, etc.).
     - *Proves Scanner*: The same query executed as `owner` detects sensitive keys (`costPrice`, `batches[0].costPrice`), proving the verification scanner is active and functional.

---

### Item 4: Token and Storage Security Audit
- **Requirement**: Access token kept in memory and refresh token in httpOnly cookie only. `localStorage` must remain empty. `sessionStorage` must never hold tokens or customer phone numbers.
- **Implementation**:
  - `AuthContext.tsx`: `token` and `accessToken` exist purely in React memory state.
  - `utils/storage.ts`: `saveCartState` only serializes product ID, names, quantities, unit prices, discounts, and customer names (stripping customer phone numbers and tokens).
- **Tests & Assertions**:
  1. `apps/web/src/test/storageAudit.test.tsx` -> `keeps access token strictly in memory and verifies localStorage is completely empty and sessionStorage contains no tokens or customer phone numbers`
     - *Asserts*: `localStorage.length === 0`.
     - *Asserts*: `sessionStorage` contains no `token`, `jwt`, `access`, `bearer`, or phone numbers matching `+94` or regex `\d{9,10}`.

---

### Item 5: Test Integrity Review
- **Requirement**: Audit assertions across Vitest and Playwright test suites. Ensure no artificial mocks, weakened checks, or silenced assertions mask underlying bugs.
- **Verification**:
  - Fixed Playwright `E2E-4` locator mapping using explicit `data-testid="split-payment-row"`, `[data-testid="split-amount-0"]`, `[data-testid="split-amount-1"]`.
  - Fixed `E2E-2` modal dismissal using keyboard `Escape` instead of broken button queries.
  - Fixed `E2E-6` & `E2E-7` title matcher to exact `"Prescription (Rx) Verification"`.
  - All assertions verify real DOM elements, real HTTP network traffic, and real database states.

---

### Item 6: Dedicated Test Database Isolation (`pharmacy_test`)
- **Requirement**: All tests run against a dedicated `pharmacy_test` database. Refuse execution if `DATABASE_URL` does not end with `_test`. Reset script (`npm run test:db:reset`).
- **Implementation**:
  - `apps/api/src/db/pool.ts`: Startup check throws fatal exception if `DATABASE_URL` or `MIGRATION_DATABASE_URL` does not end with `_test` during test execution (`NODE_ENV === 'test'` or `PLAYWRIGHT === 'true'`).
  - `db/scripts/test-db-reset.ts`: Script connects as PostgreSQL admin, terminates active connections, drops and recreates `pharmacy_test`, sets timezone to `Asia/Colombo`, runs migrations 001–008, configures `pharmacy_app` role privileges, and seeds demo data.
- **Execution**:
  - Tested and verified: `npm run test:db:reset` executes in < 3s cleanly.

---

### Item 7: Full Operational Flows Verified
All core POS billing flows have been verified through automated E2E tests:
1. **Cash Payment Flow** (`E2E-1`): Barcode scan -> Cart item added -> Pay / Checkout (F9) -> Cash tendered -> Thermal 80mm receipt preview -> Reprint audit verified -> Cart cleared.
2. **Cashier Network Security** (`E2E-2`): Zero data leakage of costs, margins, profits, or suppliers across all cashier operations.
3. **Store Credit Sale** (`E2E-3`): Customer selected -> Pay Credit -> Zero payment rows submitted -> Server derives balance due and posts customer ledger entry -> Thermal receipt shows balance due.
4. **Split Payment** (`E2E-4`): Cash Rs. 2.00 + Card Rs. 2.00 -> Both real tenders submitted in payload -> Thermal receipt shows breakdown with `Cash:` and `Card:`.
5. **Sales History & Void** (`E2E-5`): Pharmacist opens Sales History -> Voids sale with audit reason -> Batches stock restored immediately via `stock_movements`.
6. **Prescription Verification Flow** (`E2E-6`): Adding Rx item (Amoxicillin) flags bill -> Pharmacist opens Rx verification modal -> Inputs Doctor and Patient details -> Successfully finalized.
7. **Cashier Rx Block** (`E2E-7`): Cashier attempts to checkout Rx item -> Blocked with *"Pharmacist or Owner verification required"* banner -> Confirm button disabled.
8. **Idempotency Across Reload** (`E2E-8`): In-progress cart retains exact idempotency UUID across browser refresh -> Single sale bill generated upon checkout.

---

### Item 8: Repository Artifacts & Screenshots
The following screenshot artifacts are saved in `docs/step6/` inside the repository:
- `docs/step6/pos_screen.png`: POS billing terminal with product search, cart table, and running preview totals.
- `docs/step6/payment_dialog.png`: Multi-tender settlement dialog showing cash tendered and change preview.
- `docs/step6/receipt.png`: 80mm thermal receipt format with ESC/POS styling, cashier, items, discounts, and bill number.
- `docs/step6/credit_sale.png`: Store credit checkout view with customer selected and zero payments row invariant.
- `docs/step6/split_payment.png`: Split payment view with multiple tender breakdown (Cash + Card).
- `docs/step6/sales_history_void.png`: Sales transactions history view with reprint and void confirmation modal.
- `docs/step6/rx_modal.png`: Prescription (Rx) verification modal requiring doctor and patient information.

---

### Item 9: Frontend Performance & Bundle Optimization
- **Requirement**: Code-split secondary views, production bundle size < 250 KB gzipped.
- **Vite Build Metrics (`npm --workspace=apps/web run build`)**:
  ```
  dist/index.html                             0.53 kB │ gzip:  0.35 kB
  dist/assets/index-BWVYeHns.css             29.66 kB │ gzip:  5.62 kB
  dist/assets/ReceiptModal-ChEs62MX.js        8.73 kB │ gzip:  2.86 kB (Code-split)
  dist/assets/SalesHistoryView-DkUPReT4.js    8.74 kB │ gzip:  2.86 kB (Code-split)
  dist/assets/index-DKVeE-HJ.js             266.64 kB │ gzip: 81.15 kB (Main bundle)
  ```
- **Result**: The main bundle is **81.15 kB gzipped**, which is **67.5% below** the 250 KB threshold.

---

### Item 10: Git Branch Hygiene & Secret Protection
- **Branch**: `phase1/step-6-pos-ui`
- **Environment & Secrets**: `.env` and `.env.test` are strictly gitignored.
- **Database Safety**: Tests refuse to boot if credentials match defaults in production mode.

---

## 3. Summary of Test Results

```
================================================================================
FINAL VERIFICATION TEST SUMMARY
================================================================================
Backend Integration Suite (Vitest / PostgreSQL 16):    152 / 152 PASSED (100%)
Frontend Unit & Component Suite (Vitest / React 19):     23 /  23 PASSED (100%)
Playwright E2E Suite (Chromium / Real Browser):           8 /   8 PASSED (100%)
Production Bundle Size:                                   81.15 kB gzipped (< 250 kB)
================================================================================
ALL SYSTEMS PASSING. STEP 6 POS BILLING UI HARDENING IS COMPLETE.
================================================================================
```
