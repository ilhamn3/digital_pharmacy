# Step 4: Purchases (GRN), Inventory Stock Adjustments & Non-Owner Role Hardening

## 1. Overview & Architectural Invariants

Step 4 implements end-to-end procurement (Goods Received Notes / GRN), batch-level stock mutations via append-only movements, double-entry supplier credit ledger transactions, stock adjustments with owner approval thresholds, and strict role isolation where cashiers are forbidden from inspecting costs, purchases, or adjustments.

### 1.1 Non-Owner Database Role (`pharmacy_app`)
- The PostgreSQL database role `pharmacy_app` is created as `NOLOGIN` in migration `1700000000005_role_and_grn_hardening.sql`. Credentials and `LOGIN` privileges are configured via `npm run db:setup-role` (`db/scripts/setup-app-role.ts`) using `MIGRATION_DATABASE_URL`.
- Privileges granted to `pharmacy_app`:
  - `SELECT`, `INSERT`, `UPDATE` on all tables in `public`.
  - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO pharmacy_app`.
  - `DELETE` and `TRUNCATE` are explicitly revoked on all tables, with `DELETE` granted strictly on `refresh_tokens` and `hold_bill_items`.
- Startup security check (`assertAppRoleSecurity` in `apps/api/src/db/pool.ts`): Refuses to boot the API server in production (`NODE_ENV === 'production'`) if the connected database role is a superuser or table owner.

---

## 2. Purchases (GRN) Invariants & Endpoints

### 2.1 Atomic Purchase Transaction (`POST /api/v1/purchases`)
Executed within a single database transaction:
1. **Supplier Lock**: `SELECT id, name, outstanding_balance FROM suppliers WHERE id = $1 FOR UPDATE`.
2. **Purchase Header**: Inserted into `purchases` with status `'received'`.
3. **Pack Sizing & Cost Calculations**:
   - Pack input: `packsReceived`, `packSizeSnapshot` (defaults to `product.pack_size`), `packCost`.
   - Smallest sellable unit quantity: $\text{quantity} = \text{packsReceived} \times \text{packSizeSnapshot}$.
   - High-precision unit cost: $\text{unitCostPrice} = \text{ROUND}(\text{packCost} / \text{packSizeSnapshot}, 4)$ (`NUMERIC(14,4)`).
   - Line total: $\text{lineTotal} = \text{ROUND}(\text{packsReceived} \times \text{packCost}, 2)$.
   - Grand total: $\text{totalAmount} = \sum \text{lineTotal}$.
4. **New Batch Creation**: A new batch row is inserted with `current_quantity = 0.00`. Same batch number on subsequent purchases is permitted as a distinct batch row to accommodate cost price variations.
5. **Stock Movement Trigger**: A `stock_movements` record (`movement_type = 'purchase'`, `qty_change = quantity`) is inserted. The database trigger `apply_stock_movement_to_batch` applies the positive change to `batches.current_quantity`.
6. **Supplier Ledger Entry**: Double-entry record inserted into `supplier_ledger` (`entry_type = 'purchase_credit'`, `amount = totalAmount`, `balance_after = previousBalance + totalAmount`). The trigger `apply_supplier_ledger_to_supplier` updates `suppliers.outstanding_balance`.
7. **Audit Log**: Audit trail record written in the same transaction using the identical database connection client (`logAuditWithClient`).

### 2.2 Validation Rules
- **Duplicate Invoice**: `(supplier_id, lower(invoice_no))` uniqueness enforced; returns `409 Conflict`.
- **Expiry Date**: Expiry date must be in the future. Batches already expired are rejected (`400 Bad Request`) unless overridden by an `owner` with a documented reason (`overrideExpiry = true`, `overrideReason = '...'`). Expiry under 90 days returns an advisory warning in the response payload.
- **MRP Below Cost**: Flags an advisory warning in the response payload without blocking procurement.

### 2.3 Correction by Voiding (`POST /api/v1/purchases/:id/void`)
- Purchases are immutable and cannot be updated directly.
- Voiding is blocked (`409 Conflict` / `400 Bad Request`) if any batch received in the purchase has already been sold, dispensed, or reduced below the received quantity (`b.current_quantity < pi.quantity`). Returns the list of depleted batches.
- If intact, atomically:
  - Reverses stock via `stock_movements` (`movement_type = 'void'`, negative quantity change).
  - Deactivates batches (`is_active = false`).
  - Reverses supplier payable via `supplier_ledger` (`entry_type = 'return_debit'`, negative amount).
  - Updates purchase record: `status = 'voided'`, `void_reason`, `voided_by`, `voided_at`.
  - Trigger `protect_purchases_voided_state` blocks modifying or un-voiding a voided purchase.

---

## 3. Stock Adjustments & Inventory Lists

### 3.1 Stock Adjustments (`POST /api/v1/stock/adjustments`)
- Adjustment types: `'damage'`, `'expired_write_off'`, `'correction'`.
- Mandatory reason (minimum 3 characters).
- Atomic transaction:
  1. Target batch locked with `FOR UPDATE`.
  2. Non-negative validation: `current_quantity + quantityChange >= 0`.
  3. Owner approval threshold: Evaluates `adjustmentValue = |quantityChange| * batch.cost_price`. If value exceeds threshold (`inventory_settings.max_unapproved_adjustment_cost`, default Rs. 5,000.00), user role must be `owner`; pharmacists receive `403 Forbidden`.
  4. Inserts `stock_movements` (`movement_type = 'adjustment'`).
  5. Inserts `stock_adjustments` linking `movement_id`.
  6. Writes audit log.

### 3.2 Inventory Lists
- `GET /api/v1/stock/low-stock`: Products where active non-expired stock $\le$ `reorder_level`, with total `value_at_cost`.
- `GET /api/v1/stock/expiring`: Batches expiring within 30, 60, or 90 days, with `value_at_cost`.
- `GET /api/v1/stock/expired`: Expired batches with positive remaining stock (write-off candidates), with `value_at_cost`.
- `GET /api/v1/stock/reconcile/:batchId`: Reconciles $\text{batches.current\_quantity} = \sum \text{stock\_movements.qty\_change}$.

---

## 4. Supplier Payments (`POST /api/v1/suppliers/:id/payments`)
- Writes `supplier_payments` and `supplier_ledger` (`entry_type = 'payment'`) in one atomic transaction.
- Balance cannot become negative unless `allowOverpayment = true` is explicitly provided.

