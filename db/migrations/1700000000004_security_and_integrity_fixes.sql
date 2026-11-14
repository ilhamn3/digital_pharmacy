-- Up Migration

-- 1. Reset pharmacy.in_movement_trigger to 'false' after UPDATE to prevent direct batch updates in same tx
CREATE OR REPLACE FUNCTION apply_stock_movement_to_batch()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM set_config('pharmacy.in_movement_trigger', 'true', true);

    UPDATE batches
    SET current_quantity = current_quantity + NEW.qty_change,
        updated_at = NOW()
    WHERE id = NEW.batch_id;

    PERFORM set_config('pharmacy.in_movement_trigger', 'false', true);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Non-owner app role (pharmacy_app: SELECT/INSERT/UPDATE only, no TRUNCATE, not table owner)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pharmacy_app') THEN
    CREATE ROLE pharmacy_app WITH LOGIN PASSWORD 'pharmacy_app_pass';
  END IF;
END $$;

GRANT CONNECT ON DATABASE pharmacy_pos TO pharmacy_app;
GRANT USAGE ON SCHEMA public TO pharmacy_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO pharmacy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pharmacy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO pharmacy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pharmacy_app;

-- Explicitly revoke DELETE and TRUNCATE
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM pharmacy_app;

-- 3. Ensure deferred constraint trigger on sales table exists
DROP TRIGGER IF EXISTS trg_verify_sales_totals_sales ON sales;
CREATE CONSTRAINT TRIGGER trg_verify_sales_totals_sales
    AFTER INSERT OR UPDATE ON sales
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION verify_sales_totals_deferred();

-- 4. Ledger-only updates for customers.credit_balance and suppliers.outstanding_balance
CREATE OR REPLACE FUNCTION apply_customer_ledger_to_customer()
RETURNS TRIGGER AS $$
DECLARE
    v_expected_balance NUMERIC(12,2);
BEGIN
    PERFORM set_config('pharmacy.in_customer_ledger_trigger', 'true', true);

    SELECT credit_balance + NEW.amount INTO v_expected_balance
    FROM customers
    WHERE id = NEW.customer_id
    FOR UPDATE;

    IF v_expected_balance <> NEW.balance_after THEN
        RAISE EXCEPTION 'Customer ledger balance mismatch: previous balance + amount (%) equals %, but balance_after is %',
            NEW.amount, v_expected_balance, NEW.balance_after;
    END IF;

    UPDATE customers
    SET credit_balance = NEW.balance_after,
        updated_at = NOW()
    WHERE id = NEW.customer_id;

    PERFORM set_config('pharmacy.in_customer_ledger_trigger', 'false', true);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_ledger_apply ON customer_ledger;
CREATE TRIGGER trg_customer_ledger_apply
    AFTER INSERT ON customer_ledger
    FOR EACH ROW
    EXECUTE FUNCTION apply_customer_ledger_to_customer();

CREATE OR REPLACE FUNCTION protect_customer_direct_balance_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.credit_balance IS DISTINCT FROM NEW.credit_balance THEN
        IF current_setting('pharmacy.in_customer_ledger_trigger', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'Direct update of customers.credit_balance is prohibited. Balance modifications must occur via customer_ledger.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_protect_balance ON customers;
CREATE TRIGGER trg_customers_protect_balance
    BEFORE UPDATE ON customers
    FOR EACH ROW
    EXECUTE FUNCTION protect_customer_direct_balance_update();

CREATE OR REPLACE FUNCTION apply_supplier_ledger_to_supplier()
RETURNS TRIGGER AS $$
DECLARE
    v_expected_balance NUMERIC(12,2);
BEGIN
    PERFORM set_config('pharmacy.in_supplier_ledger_trigger', 'true', true);

    SELECT outstanding_balance + NEW.amount INTO v_expected_balance
    FROM suppliers
    WHERE id = NEW.supplier_id
    FOR UPDATE;

    IF v_expected_balance <> NEW.balance_after THEN
        RAISE EXCEPTION 'Supplier ledger balance mismatch: previous balance + amount (%) equals %, but balance_after is %',
            NEW.amount, v_expected_balance, NEW.balance_after;
    END IF;

    UPDATE suppliers
    SET outstanding_balance = NEW.balance_after,
        updated_at = NOW()
    WHERE id = NEW.supplier_id;

    PERFORM set_config('pharmacy.in_supplier_ledger_trigger', 'false', true);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_supplier_ledger_apply ON supplier_ledger;
CREATE TRIGGER trg_supplier_ledger_apply
    AFTER INSERT ON supplier_ledger
    FOR EACH ROW
    EXECUTE FUNCTION apply_supplier_ledger_to_supplier();

CREATE OR REPLACE FUNCTION protect_supplier_direct_balance_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.outstanding_balance IS DISTINCT FROM NEW.outstanding_balance THEN
        IF current_setting('pharmacy.in_supplier_ledger_trigger', true) IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION 'Direct update of suppliers.outstanding_balance is prohibited. Balance modifications must occur via supplier_ledger.';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_suppliers_protect_balance ON suppliers;
CREATE TRIGGER trg_suppliers_protect_balance
    BEFORE UPDATE ON suppliers
    FOR EACH ROW
    EXECUTE FUNCTION protect_supplier_direct_balance_update();

-- 5. Additional Protections
-- 5a. hold_bill_items updated_at trigger
ALTER TABLE hold_bill_items ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_set_updated_at_hold_bill_items ON hold_bill_items;
CREATE TRIGGER trg_set_updated_at_hold_bill_items
    BEFORE UPDATE ON hold_bill_items
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- 5b. Block UPDATE of batches.product_id
CREATE OR REPLACE FUNCTION protect_batch_product_id_update()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.product_id IS DISTINCT FROM NEW.product_id THEN
        RAISE EXCEPTION 'Modification of batches.product_id is strictly prohibited';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_batches_protect_product_id ON batches;
CREATE TRIGGER trg_batches_protect_product_id
    BEFORE UPDATE ON batches
    FOR EACH ROW
    EXECUTE FUNCTION protect_batch_product_id_update();

-- 5c. stock_adjustments.movement_id FK
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS movement_id UUID REFERENCES stock_movements(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_movement_id ON stock_adjustments(movement_id);


-- Down Migration

ALTER TABLE stock_adjustments DROP COLUMN IF EXISTS movement_id;
DROP TRIGGER IF EXISTS trg_batches_protect_product_id ON batches;
DROP FUNCTION IF EXISTS protect_batch_product_id_update();
DROP TRIGGER IF EXISTS trg_set_updated_at_hold_bill_items ON hold_bill_items;
ALTER TABLE hold_bill_items DROP COLUMN IF EXISTS updated_at;

DROP TRIGGER IF EXISTS trg_suppliers_protect_balance ON suppliers;
DROP FUNCTION IF EXISTS protect_supplier_direct_balance_update();
DROP TRIGGER IF EXISTS trg_supplier_ledger_apply ON supplier_ledger;
DROP FUNCTION IF EXISTS apply_supplier_ledger_to_supplier();

DROP TRIGGER IF EXISTS trg_customers_protect_balance ON customers;
DROP FUNCTION IF EXISTS protect_customer_direct_balance_update();
DROP TRIGGER IF EXISTS trg_customer_ledger_apply ON customer_ledger;
DROP FUNCTION IF EXISTS apply_customer_ledger_to_customer();

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

