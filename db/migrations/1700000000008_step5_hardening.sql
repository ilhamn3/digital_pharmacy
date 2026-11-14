-- Up Migration

-- 1. Add idempotency_hash to sales table to detect payload tampering on retried idempotency keys
ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_hash VARCHAR(64);

-- 2. Scope idempotency key per cashier/user
DROP INDEX IF EXISTS uq_sales_idempotency_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_user_idempotency_key ON sales (cashier_id, idempotency_key);

-- 3. Update protect_sales_update() trigger to account for idempotency_hash
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

        -- Verify all immutable financial, customer, and transactional fields remain identical
        IF NEW.id IS DISTINCT FROM OLD.id OR
           NEW.bill_no IS DISTINCT FROM OLD.bill_no OR
           NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR
           NEW.idempotency_hash IS DISTINCT FROM OLD.idempotency_hash OR
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

-- Down Migration

DROP INDEX IF EXISTS uq_sales_user_idempotency_key;

SET LOCAL session_replication_role = 'replica';
UPDATE sales
SET idempotency_key = gen_random_uuid()
WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY idempotency_key ORDER BY created_at) as rn
        FROM sales
        WHERE idempotency_key IS NOT NULL
    ) t WHERE t.rn > 1
);
SET LOCAL session_replication_role = 'origin';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_idempotency_key ON sales (idempotency_key);
ALTER TABLE sales DROP COLUMN IF EXISTS idempotency_hash;
