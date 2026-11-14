-- Up Migration

-- 1. Add idempotency_key to sales table (UUID NOT NULL UNIQUE)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_key UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_idempotency_key ON sales (idempotency_key);

-- 2. Add allow_fractional_qty to products table
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_fractional_qty BOOLEAN NOT NULL DEFAULT false;

-- 3. Seed default POS, tax, discount, and Rx settings
INSERT INTO settings (key, value, description)
VALUES 
    ('tax_rate', '{"rate": 0.00}'::jsonb, 'Standard sales tax / VAT rate (percentage)'),
    ('role_discount_limits', '{"cashier": 5.00, "pharmacist": 15.00, "owner": 100.00}'::jsonb, 'Maximum allowed discount percentage by user role'),
    ('rx_settings', '{"rx_requires_pharmacist": true}'::jsonb, 'Prescription dispensing security settings'),
    ('sales_settings', '{"sale_void_same_day_only": true}'::jsonb, 'Sales void business rules and restrictions')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW();

-- Ensure inventory_settings has min_sellable_shelf_life_days
UPDATE settings
SET value = jsonb_set(value, '{min_sellable_shelf_life_days}', '0'::jsonb, true),
    updated_at = NOW()
WHERE key = 'inventory_settings';

-- 4. Trigger on sales to enforce immutability except for valid void transitions
CREATE OR REPLACE FUNCTION protect_sales_update()
RETURNS TRIGGER AS $$
BEGIN
    -- If already voided, block any update
    IF OLD.status = 'voided' THEN
        RAISE EXCEPTION 'Cannot modify a voided sale';
    END IF;

    -- Allow ONLY transition to 'voided' with valid void fields
    IF NEW.status = 'voided' THEN
        IF NEW.void_reason IS NULL OR TRIM(NEW.void_reason) = '' THEN
            RAISE EXCEPTION 'Void reason is mandatory when voiding a sale';
        END IF;
        IF NEW.voided_by IS NULL THEN
            RAISE EXCEPTION 'voided_by is mandatory when voiding a sale';
        END IF;
        IF NEW.voided_at IS NULL THEN
            RAISE EXCEPTION 'voided_at is mandatory when voiding a sale';
        END IF;

        -- Verify all immutable financial and transactional fields remain identical
        IF NEW.id IS DISTINCT FROM OLD.id OR
           NEW.bill_no IS DISTINCT FROM OLD.bill_no OR
           NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
           NEW.customer_id IS DISTINCT FROM OLD.customer_id OR
           NEW.has_rx_items IS DISTINCT FROM OLD.has_rx_items OR
           NEW.subtotal IS DISTINCT FROM OLD.subtotal OR
           NEW.discount_amount IS DISTINCT FROM OLD.discount_amount OR
           NEW.discount_percent IS DISTINCT FROM OLD.discount_percent OR
           NEW.tax_amount IS DISTINCT FROM OLD.tax_amount OR
           NEW.total_amount IS DISTINCT FROM OLD.total_amount OR
           NEW.paid_amount IS DISTINCT FROM OLD.paid_amount OR
           NEW.tendered_amount IS DISTINCT FROM OLD.tendered_amount OR
           NEW.change_amount IS DISTINCT FROM OLD.change_amount OR
           NEW.balance_due IS DISTINCT FROM OLD.balance_due OR
           NEW.payment_status IS DISTINCT FROM OLD.payment_status OR
           NEW.doctor_name IS DISTINCT FROM OLD.doctor_name OR
           NEW.patient_name IS DISTINCT FROM OLD.patient_name OR
           NEW.notes IS DISTINCT FROM OLD.notes OR
           NEW.cashier_id IS DISTINCT FROM OLD.cashier_id OR
           NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
            RAISE EXCEPTION 'Direct update of sales records is prohibited except for voiding with reason, voided_by, and voided_at';
        END IF;

        NEW.updated_at := NOW();
        RETURN NEW;
    END IF;

    -- Block every other direct update
    RAISE EXCEPTION 'Direct update of sales records is prohibited except for voiding with reason, voided_by, and voided_at';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_sales_update ON sales;
CREATE TRIGGER trg_protect_sales_update
    BEFORE UPDATE ON sales
    FOR EACH ROW
    EXECUTE FUNCTION protect_sales_update();

-- Down Migration

DROP TRIGGER IF EXISTS trg_protect_sales_update ON sales;
DROP FUNCTION IF EXISTS protect_sales_update();

DELETE FROM settings WHERE key IN ('tax_rate', 'role_discount_limits', 'rx_settings', 'sales_settings');

ALTER TABLE products DROP COLUMN IF EXISTS allow_fractional_qty;

DROP INDEX IF EXISTS uq_sales_idempotency_key;
ALTER TABLE sales DROP COLUMN IF EXISTS idempotency_key;
