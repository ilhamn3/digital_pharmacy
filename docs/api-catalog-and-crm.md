# Catalog & CRM API Documentation (Step 3)

## 1. Overview
The Catalog and CRM subsystem manages Products, Batches, Suppliers, Customers, and Opening Stock CSV Imports with strict financial precision, zero stock drift, and multi-tenant cashier data segregation.

---

## 2. Cashier Data Protection Model
Retail cashiers in Sri Lanka operate the billing counter and POS search. They must never see supplier identities, cost prices, pack costs, or purchase prices.

### 2.1 Two-Layer Defense Architecture
1. **Layer 1: Database Whitelist Projection**
   - When `req.user.role === 'cashier'`, SQL queries execute with explicit column whitelists.
   - For example, batch lookups for cashiers execute:
     ```sql
     SELECT id, batch_no, expiry_date, mrp, initial_quantity, current_quantity, is_active
     FROM batches WHERE product_id = $1 AND is_active = true
     ```
     `cost_price`, `supplier_id`, and `supplier_name` are never selected.
2. **Layer 2: Response Body Scrubber**
   - The `cashierDataSanitizer` interceptor intercepts every outgoing response body.
   - Deeply redacts `cost_price`, `unit_cost_price`, `unit_cost`, `pack_cost`, `purchase_cost`, `purchase_price`, `supplier`, `supplier_id`, `supplier_name`, and `supplier_balance`.
3. **Endpoint Isolation**:
   - `/api/v1/suppliers` and `/api/v1/purchases` enforce `requireRoles('owner', 'pharmacist')`, returning `403 Forbidden` for cashiers.

---

## 3. Endpoints

### 3.1 Products (`/api/v1/products`)
| Method | Path | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | All roles | Search products by name, generic name, or barcode. Aggregates stock across active batches. |
| `GET` | `/export-csv` | Owner, Pharmacist | Exports catalog as CSV with UTF-8 BOM and formula injection protection. |
| `GET` | `/:id` | All roles | Product details with active FEFO batches (cashiers receive zero cost/supplier data). |
| `POST` | `/` | Owner, Pharmacist | Create product with `pack_size`, `reorder_level`, `is_rx_required`, unique `barcode`. |
| `PUT` | `/:id` | Owner, Pharmacist | Update product fields. Logs audit record with before/after state. |
| `PATCH`| `/:id/status` | Owner, Pharmacist | Soft activate / deactivate product. Hard deletes are blocked. |
| `POST` | `/import-csv` | Owner, Pharmacist | Opening stock import with dry-run mode, atomic transaction, and Unicode support. |

---

### 3.2 Suppliers (`/api/v1/suppliers`)
| Method | Path | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Owner, Pharmacist | List and search suppliers. Cashier returns `403 Forbidden`. |
| `GET` | `/:id` | Owner, Pharmacist | Supplier details, contact information, outstanding balance. |
| `POST` | `/` | Owner, Pharmacist | Create supplier. |
| `PUT` | `/:id` | Owner, Pharmacist | Update supplier details. |
| `PATCH`| `/:id/status` | Owner, Pharmacist | Soft activate / deactivate supplier. |

---

### 3.3 Customers (`/api/v1/customers`)
| Method | Path | Roles Allowed | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | All roles | Search customers by name or phone for POS billing. |
| `GET` | `/:id` | All roles | Customer profile, credit balance, credit limit, and recent ledger entries. |
| `POST` | `/` | All roles | Cashier can create customer with `creditLimit = 0`. Owner/Pharmacist can set credit limit. |
| `PUT` | `/:id` | All roles | Update name/phone. Cashiers attempting to modify `creditLimit` receive `403 Forbidden`. |
| `PATCH`| `/:id/status` | Owner, Pharmacist | Soft activate / deactivate customer account. |

---

## 4. Opening Stock CSV Import Specification

### 4.1 Safety & Validation Rules
1. **Dry-Run Mode First**:
   - Query parameter `?dryRun=true` or payload `{ dryRun: true }`.
   - Validates all rows, checks date formats, positive quantities, and barcode uniqueness.
   - Returns `200 OK` (if valid) or `422 Unprocessable Entity` with row-level error breakdown and a 10-row preview, committing NOTHING.
2. **Payload Limits**:
   - File size limit: 5 MB (`CSV_MAX_FILE_SIZE_BYTES`).
   - Row limit: 5,000 rows (`CSV_MAX_ROW_COUNT`).
3. **Atomic Transaction**:
   - Execution runs inside a single `BEGIN ... COMMIT` block.
   - Any unhandled failure triggers an immediate `ROLLBACK`.
4. **Stock Integrity via Movements**:
   - Batches are inserted with `current_quantity = 0.00`.
   - Populated exclusively by inserting `stock_movements` rows with `movement_type = 'opening_stock'`.
   - Database trigger `trg_stock_movements_apply` updates `batches.current_quantity`.
5. **Pack Size & Cost Conversion**:
   - If `pack_cost` and `pack_size` are provided, unit cost is calculated as:
     $$\text{unit\_cost} = \text{ROUND}(\text{pack\_cost} / \text{pack\_size}, 4)$$
   - Stored in `batches.cost_price` as `NUMERIC(14,4)`.
6. **Unicode & BOM Compatibility**:
   - Automatically detects and strips UTF-8 Byte Order Mark (`\uFEFF`).
   - Supports Sinhala (e.g. `පැරසිටමෝල්`) and Tamil (e.g. `பாராசிட்டமால்`) brand names.
7. **CSV Formula Injection Defense**:
   - On CSV exports, cells starting with `=`, `+`, `-`, or `@` are automatically escaped with a leading single quote (`'`).

