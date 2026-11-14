-- Migration: 1700000000003_sales_triggers_and_fixes.sql
-- Description: Attach deferred constraint triggers to sales table to prevent 0-item sales at COMMIT,
--              and enforce deferred sales subtotal and payment reconciliations.

-- 1. Upgrade verify_sales_totals_deferred to handle events on sales itself
CREATE OR REPLACE FUNCTION verify_sales_totals_deferred()
RETURNS TRIGGER AS $$
DECLARE
    v_sale_id UUID;
    v_subtotal NUMERIC(12,2);
    v_paid_amount NUMERIC(12,2);
    v_status VARCHAR(20);
    v_calc_subtotal NUMERIC(12,2);
    v_calc_paid NUMERIC(12,2);
    v_item_count INT;
BEGIN
    IF TG_TABLE_NAME = 'sales' THEN
        IF TG_OP = 'DELETE' THEN
            RETURN NULL;
        ELSE
            v_sale_id := NEW.id;
        END IF;
    ELSE
        IF TG_OP = 'DELETE' THEN
            v_sale_id := OLD.sale_id;
        ELSE
            v_sale_id := NEW.sale_id;
        END IF;
    END IF;

    SELECT subtotal, paid_amount, status INTO v_subtotal, v_paid_amount, v_status 
    FROM sales 
    WHERE id = v_sale_id;

    IF FOUND AND v_status <> 'voided' THEN
        -- Check 1: Sale must have at least one sale item
        SELECT COUNT(*), COALESCE(SUM(line_total), 0.00) 
        INTO v_item_count, v_calc_subtotal 
        FROM sale_items 
        WHERE sale_id = v_sale_id;

        IF v_item_count = 0 THEN
            RAISE EXCEPTION 'Deferred integrity check failed: sale % has 0 sale items. Every sale must contain at least one item.', v_sale_id;
        END IF;

        -- Check 2: Subtotal must equal sum of line totals
        IF v_calc_subtotal <> v_subtotal THEN
            RAISE EXCEPTION 'Deferred integrity check failed: sales.subtotal (%) does not equal sum(sale_items.line_total) (%) for sale %',
                v_subtotal, v_calc_subtotal, v_sale_id;
        END IF;

        -- Check 3: Paid amount must equal sum of payment records
        SELECT COALESCE(SUM(amount), 0.00) INTO v_calc_paid FROM payments WHERE sale_id = v_sale_id;
        IF v_calc_paid <> v_paid_amount THEN
            RAISE EXCEPTION 'Deferred integrity check failed: sales.paid_amount (%) does not equal sum(payments.amount) (%) for sale %',
                v_paid_amount, v_calc_paid, v_sale_id;
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 2. Attach deferred constraint trigger to sales table
DROP TRIGGER IF EXISTS trg_verify_sales_totals_sales ON sales;
CREATE CONSTRAINT TRIGGER trg_verify_sales_totals_sales
    AFTER INSERT OR UPDATE ON sales
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION verify_sales_totals_deferred();

-- Ensure sale_items and payments still trigger deferred verification
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

-- Down Migration

DROP TRIGGER IF EXISTS trg_verify_sales_totals_sales ON sales;


