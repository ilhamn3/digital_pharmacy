# Pharmacy POS - Phase 1 Schema Decisions & Hardening Architecture

## 1. Overview & Hardening Invariants (Migration 001 + 002)

### 1.1 Money, Precision & Rounding Rules
- **Currency & Precision**:
  - All public monetary values, retail prices, MRPs, totals, discounts, and payments use `NUMERIC(12, 2)`.
  - **Wholesale and Batch Unit Costs**: Stored with 4 decimal places as `NUMERIC(14, 4)` on `batches.cost_price`, `purchase_items.cost_price`, `sale_items.unit_cost_price`, and `supplier_return_items.unit_cost`.
- **Authoritative Single Rounding Rule**:
  $$\text{line\_total} = \text{ROUND}((\text{quantity} \times \text{unit\_selling\_price}) - \text{discount\_amount}, 2)$$
  $$\text{unit\_cost} = \frac{\text{pack\_cost}}{\text{pack\_size}} \quad (\text{stored as } \text{NUMERIC}(14,4))$$
  $$\text{COGS} = \text{ROUND}(\text{quantity} \times \text{unit\_cost\_price}, 2)$$
- **Precision Proof (Box of 1000 / 30 selling 30 units)**:
  - Pack cost = Rs. 1000.00, Pack size = 30 tablets.
  - $\text{Unit cost} = \text{ROUND}(1000.00 / 30, 4) = 33.3333$.
  - When all 30 units are sold:
    $$\text{COGS} = \text{ROUND}(30 \times 33.3333, 2) = \text{ROUND}(999.999, 2) = 1000.00$$
  - Eliminates IEEE 754 floating-point errors and guarantees zero penny drift on full pack depletion.

---

### 1.2 Stock Integrity & Double-Entry Ledger
- **No Product-Level Stock Column**: Total stock is strictly computed as $\sum \text{batches.current\_quantity}$.
- **`stock_movements` as the Sole Stock Mutation Channel**:
  - `batches.current_quantity` starts at `0.00`.
  - An `AFTER INSERT` trigger on `stock_movements` (`trg_stock_movements_apply`) applies `qty_change` to `batches.current_quantity`.
  - A `BEFORE UPDATE` trigger on `batches` (`trg_batches_protect_stock`) rejects any direct `UPDATE` of `batches.current_quantity` unless executed by the movement trigger (verified via transaction-local session state).
- **Movement Sign Invariants**:
  - `opening_stock`, `purchase`, `sales_return`: `qty_change > 0`
  - `sale`, `supplier_return`: `qty_change < 0`
  - `adjustment`, `void`: `qty_change <> 0`
- **Reconciliation Invariant**:
  $$\text{batches.current\_quantity} = \sum_{\text{batch}} \text{stock\_movements.qty\_change}$$

---

### 1.3 Database Role Security & TRUNCATE/DELETE Protection
- **Role Permissions Requirement**: In production, the application database user must **not** own tables and must **never** be granted the `TRUNCATE` privilege.
- **Trigger-Level TRUNCATE Defense**:
  - `BEFORE TRUNCATE` triggers (`prevent_truncate_on_ledger()`) are attached to all financial and audit tables (`audit_logs`, `sales`, `sale_items`, `payments`, `purchases`, `purchase_items`, `batches`, `stock_movements`, `customer_payments`, `supplier_payments`, `customer_ledger`, `supplier_ledger`). Any attempt to truncate immediately aborts with an exception.
- **Permanent Ledger Tables (No DELETE / No UPDATE)**:
  - `DELETE` is prohibited on: `sales`, `payments`, `purchases`, `batches`, `customer_payments`, `supplier_payments`, `sales_returns`, `supplier_returns`.
  - `UPDATE` and `DELETE` are prohibited on: `payments`, `customer_payments`, `supplier_payments`, `sales_return_items`, `supplier_return_items`, `customer_ledger`, `supplier_ledger`, `audit_logs`, `stock_movements`.

---

### 1.4 Deferred Integrity Constraints on Sales Commit
- **`trg_verify_sales_totals_items` & `trg_verify_sales_totals_payments`**:
  Configured as `DEFERRABLE INITIALLY DEFERRED`. At transaction commit time, PostgreSQL automatically verifies:
  $$\text{sales.subtotal} = \sum \text{sale\_items.line\_total}$$
  $$\text{sales.paid\_amount} = \sum \text{payments.amount}$$
  If a transaction leaves any mathematical gap between the header totals and the sum of child items/payments, the transaction is automatically aborted by the database.

---

### 1.5 Timezone Architecture
- Configured at database level:
  ```sql
  DO $$
  BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Colombo');
  END $$;
  ```
- All pooled connections automatically execute within `Asia/Colombo` (UTC+05:30).

---

### 1.6 Demo Seed Idempotency
- **Why it is idempotent without `UNIQUE(product_id, batch_no)`**:
  While the database allows identical batch numbers from distinct supplier purchase invoices, `db/seeds/demo.ts` performs an explicit lookup:
  ```sql
  SELECT id FROM batches WHERE product_id = $1 AND batch_no = $2
  ```
  If the batch already exists in the database, batch creation and opening movement creation are skipped. This ensures re-running `npm run db:seed:demo` is strictly idempotent and never creates duplicate demo inventory rows.

---

### 1.7 Payments vs Tendered Amount Integrity Rule
- **Payments amount is strictly the amount applied to the bill**:
  `payments.amount` stores the exact amount credited against the bill's balance due ($\le \text{total\_amount}$), NEVER the customer's tendered cash.
  - For example, if a bill is LKR 800.00 and the customer hands over a 1,000.00 banknote:
    - `sales.total_amount` = `800.00`
    - `sales.tendered_amount` = `1000.00`
    - `sales.paid_amount` = `800.00`
    - `sales.change_amount` = `200.00` (`tendered_amount - paid_amount`)
    - `sales.balance_due` = `0.00` (`total_amount - paid_amount`)
    - `payments` row: `{ payment_type: 'cash', amount: 800.00, reference_no: 'TENDERED_1000_CHANGE_200' }`
  - Deferred constraint check `trg_verify_sales_totals_payments` asserts $\text{sales.paid\_amount} = \sum \text{payments.amount} = 800.00$.

---

### 1.8 Constraint Triggers Attached Directly to Sales
- In Migration `1700000000003_sales_triggers_and_fixes.sql`, the deferred trigger `trg_verify_sales_totals_sales` is attached directly to the `sales` table (`AFTER INSERT OR UPDATE`).
- If an application attempt inserts a sale record with `subtotal > 0` but zero child items, or commits a sale with zero items (`COUNT(*) FROM sale_items = 0`), the deferred check automatically aborts the transaction at `COMMIT` time:
  ```
  Deferred integrity check failed: sale <id> has 0 sale items. Every sale must contain at least one item.
  ```

---

### 1.9 COGS Calculation Rule for Financial Reports
- Financial and inventory reports must calculate Cost of Goods Sold (COGS) on the aggregate product sum, NEVER summing per-line rounded figures:
  $$\text{COGS} = \text{ROUND}\left( \sum (\text{quantity} \times \text{unit\_cost\_price}), 2 \right)$$
- This guarantees zero decimal roundoff drift for medicines broken down into unit selling quantities (e.g. 30 tablets from a box costing 1,000.00 at unit cost 33.3333 results in exactly $\text{ROUND}(30 \times 33.3333, 2) = 1,000.00$, rather than 999.90).

---

## 2. Table Catalog & Constraint Matrix

| Table | Immutability / Protections | Key Constraints & Checks |
| :--- | :--- | :--- |
| `users` | Row-updated_at trigger | Unique lower(username), lower(email); lockout & password change fields |
| `refresh_tokens` | Rotation & family tracking | SHA-256 hash, family_id, replaced_by, ip_address, user_agent |
| `audit_logs` | Append-only (No UPDATE/DELETE/TRUNC) | `user_id ON DELETE RESTRICT`, `entity_id TEXT`, deep secret redaction |
| `products` | Row-updated_at trigger | Trigram GIN indexes on `name` & `generic_name`; `pack_size >= 1` |
| `batches` | No direct stock update; No DELETE/TRUNC | `cost_price NUMERIC(14,4)`, `current_quantity >= 0`, FEFO index |
| `stock_movements` | Append-only (No UPDATE/DELETE/TRUNC) | `qty_change <> 0`, strict sign rules per movement type |
| `purchases` | No DELETE/TRUNC | `UNIQUE (supplier_id, invoice_no) WHERE status = 'received'` |
| `purchase_items` | Append-only (No UPDATE/DELETE/TRUNC) | `cost_price NUMERIC(14,4)`, `pack_size_snapshot`, `pack_cost` |
| `sales` | No DELETE/TRUNC | `tendered_amount >= paid_amount`, `paid_amount <= total_amount`, change calc check |
| `sale_items` | Append-only (No UPDATE/DELETE/TRUNC) | `unit_cost_price NUMERIC(14,4)`, exact line_total check, deferred subtotal sum check |
| `payments` | Append-only (No UPDATE/DELETE/TRUNC) | Tender types strictly `cash`, `card`, `bank_transfer`; deferred paid_amount sum check |
| `customer_ledger` | Append-only (No UPDATE/DELETE/TRUNC) | Credit ledger with balance_after check >= 0 |
| `supplier_ledger` | Append-only (No UPDATE/DELETE/TRUNC) | Supplier payable ledger with balance_after |
