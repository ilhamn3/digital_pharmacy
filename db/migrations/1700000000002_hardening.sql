-- Up Migration

-- Ensure Asia/Colombo timezone at database level and session
DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Colombo');
END $$;

SET timezone TO 'Asia/Colombo';

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. P0: COSTS & NUMERIC(14,4) PRECISION
-- ============================================================================
ALTER TABLE batches ALTER COLUMN cost_price TYPE NUMERIC(14,4);
ALTER TABLE purchase_items ALTER COLUMN cost_price TYPE NUMERIC(14,4);
ALTER TABLE sale_items ALTER COLUMN unit_cost_price TYPE NUMERIC(14,4);
ALTER TABLE supplier_return_items ALTER COLUMN unit_cost TYPE NUMERIC(14,4);

-- Add pack sizing and pack cost snapshots to purchase_items
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS pack_size_snapshot INT NOT NULL DEFAULT 1 CHECK (pack_size_snapshot > 0);
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS packs_received NUMERIC(12,2) NOT NULL DEFAULT 1.00 CHECK (packs_received > 0);
ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS pack_cost NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (pack_cost >= 0);

-- ============================================================================
-- 2. P0: STOCK INTEGRITY (Double-Entry Movements & Triggers)
-- ============================================================================
ALTER TABLE batches ALTER COLUMN current_quantity SET DEFAULT 0.00;

-- Stock movements sign rules and non-zero check
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movement_qty_nonzero CHECK (qty_change <> 0);
ALTER TABLE stock_movements ADD CONSTRAINT chk_stock_movement_sign CHECK (
    (movement_type = 'opening_stock' AND qty_change > 0) OR
    (movement_type = 'purchase' AND qty_change > 0) OR
    (movement_type = 'sales_return' AND qty_change > 0) OR
    (movement_type = 'sale' AND qty_change < 0) OR
    (movement_type = 'supplier_return' AND qty_change < 0) OR
    (movement_type IN ('adjustment', 'void') AND qty_change <> 0)
);

-- Trigger to apply movement to batch
CREATE OR REPLACE FUNCTION apply_stock_movement_to_batch()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM set_config('pharmacy.in_movement_trigger', 'true', true);

    UPDATE batches
    SET current_quantity = current_quantity + NEW.qty_change,
        updated_at = NOW()
    WHERE id = NEW.batch_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stock_movements_apply ON stock_movements;
CREATE TRIGGER trg_stock_movements_apply
    AFTER INSERT ON stock_movements
    FOR EACH ROW
    EXECUTE FUNCTION apply_stock_movement_to_batch();

-- Trigger on batches to block direct UPDATE outside trigger path
CREATE OR REPLACE FUNCTION protect_batch_direct_stock_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.current_quantity IS DISTINCT FROM NEW.current_quantity THEN
        IF current_setting('pharmacy.in_movement_trigger', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'Direct update of batches.current_quantity is prohibited. Modifications must occur via stock_movements.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batches_protect_stock ON batches;
CREATE TRIGGER trg_batches_protect_stock
    BEFORE UPDATE ON batches
    FOR EACH ROW
    EXECUTE FUNCTION protect_batch_direct_stock_update();

-- ============================================================================
-- 3. P0: AUTH & AUDIT RESTRICTIONS
-- ============================================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Case-insensitive unique indexes for users
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_username ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_lower_email ON users (lower(email)) WHERE email IS NOT NULL;

-- Refresh tokens tracking family and rotation chain
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS replaced_by VARCHAR(128);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent TEXT;
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens(family_id);

-- Restrict user deletion when audit logs reference user
ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;

-- ============================================================================
-- 4. P1: SALES REFINEMENTS & INTEGRITY CHECKS
-- ============================================================================
ALTER TABLE sales ADD COLUMN IF NOT EXISTS tendered_amount NUMERIC(12,2);
UPDATE sales SET tendered_amount = paid_amount + change_amount WHERE tendered_amount IS NULL;
ALTER TABLE sales ALTER COLUMN tendered_amount SET NOT NULL;
ALTER TABLE sales ALTER COLUMN tendered_amount SET DEFAULT 0.00;

ALTER TABLE sales ADD CONSTRAINT chk_sales_tendered_min CHECK (tendered_amount >= paid_amount);
ALTER TABLE sales ADD CONSTRAINT chk_sales_paid_limit CHECK (paid_amount <= total_amount);
ALTER TABLE sales ADD CONSTRAINT chk_sales_change_calc CHECK (change_amount = (tendered_amount - paid_amount));
ALTER TABLE sales ADD CONSTRAINT chk_sales_discount_pct CHECK (discount_percent >= 0.00 AND discount_percent <= 100.00);

-- Purchase uniqueness per supplier invoice for received status
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_supplier_invoice_received 
ON purchases (supplier_id, invoice_no) 
WHERE status = 'received';

-- sale_items line_total check: line_total = ROUND((quantity * unit_selling_price) - discount_amount, 2)
ALTER TABLE sale_items ADD CONSTRAINT chk_sale_items_line_total 
CHECK (line_total = ROUND((quantity * unit_selling_price) - discount_amount, 2));

-- ============================================================================
-- 5. P1: IMMUTABILITY & TRUNCATE PROTECTION
-- ============================================================================
CREATE OR REPLACE FUNCTION prevent_truncate_on_ledger()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is a protected financial ledger: TRUNCATE is strictly prohibited', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Table % is a permanent ledger: DELETE is prohibited', TG_TABLE_NAME;
    ELSIF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Table % is append-only: UPDATE is prohibited', TG_TABLE_NAME;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Block DELETE on sales, purchases, batches, payments, returns
CREATE TRIGGER trg_no_delete_sales BEFORE DELETE ON sales FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_delete_purchases BEFORE DELETE ON purchases FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_delete_batches BEFORE DELETE ON batches FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_delete_sales_returns BEFORE DELETE ON sales_returns FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_delete_supplier_returns BEFORE DELETE ON supplier_returns FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- Block UPDATE and DELETE on payments and return items
CREATE TRIGGER trg_no_mutate_payments BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_mutate_customer_payments BEFORE UPDATE OR DELETE ON customer_payments FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_mutate_supplier_payments BEFORE UPDATE OR DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_mutate_sales_return_items BEFORE UPDATE OR DELETE ON sales_return_items FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();
CREATE TRIGGER trg_no_mutate_supplier_return_items BEFORE UPDATE OR DELETE ON supplier_return_items FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

-- Block TRUNCATE on all core ledger tables
CREATE TRIGGER trg_no_trunc_audit_logs BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_sales BEFORE TRUNCATE ON sales FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_sale_items BEFORE TRUNCATE ON sale_items FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_payments BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_purchases BEFORE TRUNCATE ON purchases FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_purchase_items BEFORE TRUNCATE ON purchase_items FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_batches BEFORE TRUNCATE ON batches FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_stock_movements BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_customer_payments BEFORE TRUNCATE ON customer_payments FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();
CREATE TRIGGER trg_no_trunc_supplier_payments BEFORE TRUNCATE ON supplier_payments FOR EACH STATEMENT EXECUTE FUNCTION prevent_truncate_on_ledger();

-- ============================================================================
-- 6. P1: DEFERRED CONSTRAINT TRIGGERS FOR SALES TOTALS RECONCILIATION
-- ============================================================================
CREATE OR REPLACE FUNCTION verify_sales_totals_deferred()
RETURNS TRIGGER AS $$
DECLARE
    v_sale_id UUID;
    v_subtotal NUMERIC(12,2);
    v_paid_amount NUMERIC(12,2);
    v_calc_subtotal NUMERIC(12,2);
    v_calc_paid NUMERIC(12,2);
    v_status VARCHAR(20);
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_sale_id := OLD.sale_id;
    ELSE
        v_sale_id := NEW.sale_id;
    END IF;

    SELECT subtotal, paid_amount, status INTO v_subtotal, v_paid_amount, v_status 
    FROM sales 
    WHERE id = v_sale_id;

    IF FOUND AND v_status <> 'voided' THEN
        SELECT COALESCE(SUM(line_total), 0.00) INTO v_calc_subtotal FROM sale_items WHERE sale_id = v_sale_id;
        IF v_calc_subtotal <> v_subtotal THEN
            RAISE EXCEPTION 'Deferred integrity check failed: sales.subtotal (%) does not equal sum(sale_items.line_total) (%) for sale %',
                v_subtotal, v_calc_subtotal, v_sale_id;
        END IF;

        SELECT COALESCE(SUM(amount), 0.00) INTO v_calc_paid FROM payments WHERE sale_id = v_sale_id;
        IF v_calc_paid <> v_paid_amount THEN
            RAISE EXCEPTION 'Deferred integrity check failed: sales.paid_amount (%) does not equal sum(payments.amount) (%) for sale %',
                v_paid_amount, v_calc_paid, v_sale_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_verify_sales_totals_items ON sale_items;
CREATE CONSTRAINT TRIGGER trg_verify_sales_totals_items
    AFTER INSERT OR UPDATE OR DELETE ON sale_items
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION verify_sales_totals_deferred();

DROP TRIGGER IF EXISTS trg_verify_sales_totals_payments ON payments;
CREATE CONSTRAINT TRIGGER trg_verify_sales_totals_payments
    AFTER INSERT OR UPDATE OR DELETE ON payments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION verify_sales_totals_deferred();

-- ============================================================================
-- 7. P1: CUSTOMER & SUPPLIER LEDGER TABLES (Append-Only)
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('credit_sale', 'payment', 'return_refund', 'adjustment')),
    amount NUMERIC(12,2) NOT NULL, -- positive increases debt, negative decreases debt
    balance_after NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
    ref_type VARCHAR(50) NOT NULL,
    ref_id UUID NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_ledger_created_at ON customer_ledger(created_at);

CREATE TRIGGER trg_customer_ledger_immutable
    BEFORE UPDATE OR DELETE ON customer_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_no_trunc_customer_ledger
    BEFORE TRUNCATE ON customer_ledger
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_truncate_on_ledger();

CREATE TABLE IF NOT EXISTS supplier_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    entry_type VARCHAR(30) NOT NULL CHECK (entry_type IN ('purchase_credit', 'payment', 'return_debit', 'adjustment')),
    amount NUMERIC(12,2) NOT NULL, -- positive increases payable, negative decreases payable
    balance_after NUMERIC(12,2) NOT NULL,
    ref_type VARCHAR(50) NOT NULL,
    ref_id UUID NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_ledger_supplier ON supplier_ledger(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_ledger_created_at ON supplier_ledger(created_at);

CREATE TRIGGER trg_supplier_ledger_immutable
    BEFORE UPDATE OR DELETE ON supplier_ledger
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER trg_no_trunc_supplier_ledger
    BEFORE TRUNCATE ON supplier_ledger
    FOR EACH STATEMENT
    EXECUTE FUNCTION prevent_truncate_on_ledger();

-- ============================================================================
-- 8. P2: TRIGRAM INDEXES & SET_UPDATED_AT TRIGGERS
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_generic_name_trgm ON products USING gin (generic_name gin_trgm_ops);

-- Drop redundant duplicate indexes (already backed by primary key or unique constraints)
DROP INDEX IF EXISTS idx_customers_phone;
DROP INDEX IF EXISTS idx_refresh_tokens_hash;
DROP INDEX IF EXISTS idx_sales_bill_no;
DROP INDEX IF EXISTS idx_products_barcode;

-- Generic set_updated_at function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach set_updated_at triggers
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY[
        'settings', 'users', 'refresh_tokens', 'suppliers', 'customers',
        'products', 'batches', 'purchases', 'supplier_payments', 'customer_payments',
        'stock_adjustments', 'bill_sequences', 'sales', 'payments',
        'hold_bills', 'sales_returns', 'supplier_returns', 'day_end_closes'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;', tbl);
        EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();', tbl);
    END LOOP;
END $$;


-- Down Migration

-- Drop updated_at triggers
DO $$
DECLARE
    tbl text;
    tables text[] := ARRAY[
        'settings', 'users', 'refresh_tokens', 'suppliers', 'customers',
        'products', 'batches', 'purchases', 'supplier_payments', 'customer_payments',
        'stock_adjustments', 'bill_sequences', 'sales', 'payments',
        'hold_bills', 'sales_returns', 'supplier_returns', 'day_end_closes'
    ];
BEGIN
    FOREACH tbl IN ARRAY tables LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;', tbl);
    END LOOP;
END $$;

DROP FUNCTION IF EXISTS set_updated_at();

DROP INDEX IF EXISTS idx_products_generic_name_trgm;
DROP INDEX IF EXISTS idx_products_name_trgm;

DROP TABLE IF EXISTS supplier_ledger CASCADE;
DROP TABLE IF EXISTS customer_ledger CASCADE;

DROP TRIGGER IF EXISTS trg_verify_sales_totals_payments ON payments;
DROP TRIGGER IF EXISTS trg_verify_sales_totals_items ON sale_items;
DROP FUNCTION IF EXISTS verify_sales_totals_deferred();

DROP TRIGGER IF EXISTS trg_no_trunc_supplier_payments ON supplier_payments;
DROP TRIGGER IF EXISTS trg_no_trunc_customer_payments ON customer_payments;
DROP TRIGGER IF EXISTS trg_no_trunc_stock_movements ON stock_movements;
DROP TRIGGER IF EXISTS trg_no_trunc_batches ON batches;
DROP TRIGGER IF EXISTS trg_no_trunc_purchase_items ON purchase_items;
DROP TRIGGER IF EXISTS trg_no_trunc_purchases ON purchases;
DROP TRIGGER IF EXISTS trg_no_trunc_payments ON payments;
DROP TRIGGER IF EXISTS trg_no_trunc_sale_items ON sale_items;
DROP TRIGGER IF EXISTS trg_no_trunc_sales ON sales;
DROP TRIGGER IF EXISTS trg_no_trunc_audit_logs ON audit_logs;

DROP TRIGGER IF EXISTS trg_no_mutate_supplier_return_items ON supplier_return_items;
DROP TRIGGER IF EXISTS trg_no_mutate_sales_return_items ON sales_return_items;
DROP TRIGGER IF EXISTS trg_no_mutate_supplier_payments ON supplier_payments;
DROP TRIGGER IF EXISTS trg_no_mutate_customer_payments ON customer_payments;
DROP TRIGGER IF EXISTS trg_no_mutate_payments ON payments;

DROP TRIGGER IF EXISTS trg_no_delete_supplier_returns ON supplier_returns;
DROP TRIGGER IF EXISTS trg_no_delete_sales_returns ON sales_returns;
DROP TRIGGER IF EXISTS trg_no_delete_batches ON batches;
DROP TRIGGER IF EXISTS trg_no_delete_purchases ON purchases;
DROP TRIGGER IF EXISTS trg_no_delete_sales ON sales;

DROP FUNCTION IF EXISTS prevent_ledger_mutation();
DROP FUNCTION IF EXISTS prevent_truncate_on_ledger();

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_sale_items_line_total;
DROP INDEX IF EXISTS uq_purchases_supplier_invoice_received;

ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_discount_pct;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_change_calc;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_paid_limit;
ALTER TABLE sales DROP CONSTRAINT IF EXISTS chk_sales_tendered_min;
ALTER TABLE sales DROP COLUMN IF EXISTS tendered_amount;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS idx_refresh_tokens_family;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS user_agent;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS ip_address;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS replaced_by;
ALTER TABLE refresh_tokens DROP COLUMN IF EXISTS family_id;

DROP INDEX IF EXISTS uq_users_lower_email;
DROP INDEX IF EXISTS uq_users_lower_username;

ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE users DROP COLUMN IF EXISTS locked_until;
ALTER TABLE users DROP COLUMN IF EXISTS failed_login_count;
ALTER TABLE users DROP COLUMN IF EXISTS must_change_password;

DROP TRIGGER IF EXISTS trg_batches_protect_stock ON batches;
DROP FUNCTION IF EXISTS protect_batch_direct_stock_update();

DROP TRIGGER IF EXISTS trg_stock_movements_apply ON stock_movements;
DROP FUNCTION IF EXISTS apply_stock_movement_to_batch();

ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movement_sign;
ALTER TABLE stock_movements DROP CONSTRAINT IF EXISTS chk_stock_movement_qty_nonzero;

ALTER TABLE purchase_items DROP COLUMN IF EXISTS pack_cost;
ALTER TABLE purchase_items DROP COLUMN IF EXISTS packs_received;
ALTER TABLE purchase_items DROP COLUMN IF EXISTS pack_size_snapshot;

ALTER TABLE supplier_return_items ALTER COLUMN unit_cost TYPE NUMERIC(12,2);
ALTER TABLE sale_items ALTER COLUMN unit_cost_price TYPE NUMERIC(12,2);
ALTER TABLE purchase_items ALTER COLUMN cost_price TYPE NUMERIC(12,2);
ALTER TABLE batches ALTER COLUMN cost_price TYPE NUMERIC(12,2);

