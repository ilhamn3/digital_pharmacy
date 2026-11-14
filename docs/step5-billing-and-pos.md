# Step 5: Core POS Billing Backend Architecture & Implementation Report

## Executive Summary
Step 5 (Billing Backend) for Phase 1 Core Pharmacy POS is complete and fully verified against real PostgreSQL 16. All operations enforce strict financial and inventory correctness, zero penny drift, deterministic concurrency locking, append-only stock and ledger immutability, role-based data shielding, and gap-free bill number generation.

---

## 1. Database Schema Hardening (Migration 007)
Applied exclusively via a new migration: [db/migrations/1700000000007_billing_and_pos_schema.sql](file:///d:/Desktop/dp/db/migrations/1700000000007_billing_and_pos_schema.sql). Never modified applied migrations 001–006.

1. **`sales.idempotency_key`**: `UUID NOT NULL UNIQUE DEFAULT gen_random_uuid()` with unique index `uq_sales_idempotency_key`.
2. **`products.allow_fractional_qty`**: `BOOLEAN NOT NULL DEFAULT false`. Enforces integer quantities for discrete items (e.g., tablets, capsules) while allowing fractional quantities for syrups, ointments, or bulk liquids.
3. **Settings Seed**:
   - `tax_rate`: `{"rate": 0.00}`
   - `role_discount_limits`: `{"cashier": 5.00, "pharmacist": 15.00, "owner": 100.00}`
   - `rx_settings`: `{"rx_requires_pharmacist": true}`
   - `sales_settings`: `{"sale_void_same_day_only": true}`
   - `inventory_settings`: includes `min_sellable_shelf_life_days: 0`
4. **Trigger `trg_protect_sales_update` on `sales`**:
   - Prohibits all direct `UPDATE` operations on `sales`.
   - Allows transition ONLY when transitioning to `NEW.status = 'voided'` with non-empty `void_reason`, `voided_by`, and `voided_at`.
   - Asserts that all other financial, customer, and transactional columns are `IS NOT DISTINCT FROM` their original values.
   - Blocks any mutation if `OLD.status = 'voided'`.

### Migration Up / Down / Up Verification Output
```bash
> node-pg-migrate -m migrations --envPath ../.env -d MIGRATION_DATABASE_URL down
### MIGRATION 1700000000007_billing_and_pos_schema (DOWN) ###
DROP TRIGGER IF EXISTS trg_protect_sales_update ON sales;
DROP FUNCTION IF EXISTS protect_sales_update();
DELETE FROM settings WHERE key IN ('tax_rate', 'role_discount_limits', 'rx_settings', 'sales_settings');
ALTER TABLE products DROP COLUMN IF EXISTS allow_fractional_qty;
DROP INDEX IF EXISTS uq_sales_idempotency_key;
ALTER TABLE sales DROP COLUMN IF EXISTS idempotency_key;
Migrations complete!

> node-pg-migrate -m migrations --envPath ../.env -d MIGRATION_DATABASE_URL up
### MIGRATION 1700000000007_billing_and_pos_schema (UP) ###
Migrations complete!
```

---

## 2. Checkout Engine (`POST /api/v1/sales`)
Implemented in [apps/api/src/routes/sale.routes.ts](file:///d:/Desktop/dp/apps/api/src/routes/sale.routes.ts):

1. **Client Tamper Proofing**:
   - Clients supply **only** `productId`, `quantity`, and optional `discountAmount`.
   - Prices, batch selections, cost prices, tax rates, subtotal, and total amounts are strictly computed server-side from locked DB records.
2. **Idempotency**:
   - Evaluated before transaction and guarded inside transaction via `uq_sales_idempotency_key`. Concurrent collisions query and return the committed sale with HTTP 200.
3. **Deadlock Elimination**:
   - Product IDs sorted in ascending order prior to batch queries to ensure deterministic row lock acquisition.
   - Built-in transaction retry wrapper (up to 3 retries) on PostgreSQL error codes `40P01` (deadlock) or `40001` (serialization failure).
4. **FEFO Allocation & Line Calculations**:
   - Queries active, non-expired batches ordered by `expiry_date ASC, id ASC FOR UPDATE`.
   - Slices line items across multiple batches if necessary.
   - Proportional discount allocation per slice.
   - `sale_items.line_total = ROUND((quantity * unit_selling_price) - discount_amount, 2)`.
5. **Role-Based Discount Limits**:
   - Discount percentage calculated against gross subtotal.
   - Cashier: $\le 5\%$; Pharmacist: $\le 15\%$; Owner: $\le 100\%$.
   - Violations return `403 Forbidden` (`DISCOUNT_LIMIT_EXCEEDED`).
6. **Prescription Security (Rx)**:
   - If any item in the cart requires Rx (`is_rx_required = true`):
     - `doctorName` and `patientName` are mandatory.
     - Cashier checkout is blocked (`403 RX_DISPENSING_RESTRICTED`).
7. **Credit Customer Integrity & Concurrency**:
   - Partial or credit sales (`balance_due > 0`) require a registered, active customer.
   - Locks customer `FOR UPDATE`; validates `new_balance <= credit_limit`.
   - Writes `customer_ledger` (`entry_type = 'credit_sale'`). Customer balance updated strictly via trigger.
8. **Gap-Free Bill Numbering**:
   - Generated as the final step in the transaction via atomic increment on `bill_sequences` (`sequence_key = BILL-YYYYMMDD`).
   - Aborted transactions roll back the sequence row, ensuring an unbroken sequence.
9. **Cash Payment Accounting**:
   - `paid_amount` equals amount applied to bill ($\le \text{total\_amount}$).
   - `tendered_amount` ($\ge \text{paid\_amount}$).
   - `change_amount = tendered_amount - paid_amount`.

---

## 3. Void, Receipt, and Hold Bill Endpoints

### Sales Void (`POST /api/v1/sales/:id/void`)
- Restricted to `owner` and `pharmacist` (Cashier gets `403 Forbidden`).
- Same-day business rule: non-owners cannot void past-date sales (`403 VOID_SAME_DAY_ONLY`).
- Blocked if `sales_returns` exist for the sale (`409 VOID_BLOCKED_HAS_RETURNS`).
- Restores stock to original batches via append-only `stock_movements` (`movement_type = 'void'`).
- Reverses customer balance via `customer_ledger` (`entry_type = 'adjustment'`).

### 80mm ESC/POS Thermal Receipt (`GET /api/v1/sales/:id/receipt`)
- Returns formatted 42-column ESC/POS ASCII receipt and structured JSON.
- Initial generation logs `RECEIPT_PRINTED` (`isDuplicate: false`).
- Subsequent requests log `RECEIPT_REPRINTED` (`isDuplicate: true`) with `*** DUPLICATE / REPRINT ***` header.

### Hold Bills (`POST`, `GET`, `GET :id/resume`, `POST :id/discard` under `/api/v1/hold-bills`)
- Persists cart without reserving stock or locking batch prices.
- Resume endpoint queries live active batches and reprices against current inventory.

---

## 4. Test Suite Verification
Test suite [apps/api/test/step5_pos_billing.test.ts](file:///d:/Desktop/dp/apps/api/test/step5_pos_billing.test.ts) executed against real PostgreSQL 16 as least-privileged role `pharmacy_app`.

### Test Results
```
 Test Files  7 passed (7)
      Tests  140 passed (140)
   Start at  12:39:57
   Duration  6.17s (tests 10.82s)
```

1. `schema.test.ts`: 15 passed
2. `integration.postgres.test.ts`: 17 passed
3. `catalog.test.ts`: 25 passed
4. `security_hardening.test.ts`: 17 passed
5. `step4_purchases_and_inventory.test.ts`: 32 passed
6. `step5_pos_billing.test.ts`: 23 passed
7. `auth.test.ts`: 11 passed

