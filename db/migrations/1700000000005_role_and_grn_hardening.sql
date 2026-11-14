-- Up Migration

-- 1. Ensure pharmacy_app is created as NOLOGIN (login and password will be set via deploy script)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pharmacy_app') THEN
    CREATE ROLE pharmacy_app WITH NOLOGIN;
  ELSE
    ALTER ROLE pharmacy_app WITH NOLOGIN;
  END IF;
END $$;

-- 2. Configure default privileges for future tables/sequences created by owner
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO pharmacy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pharmacy_app;

-- 3. Ensure permissions on existing tables: SELECT, INSERT, UPDATE only
GRANT CONNECT ON DATABASE pharmacy_pos TO pharmacy_app;
GRANT USAGE ON SCHEMA public TO pharmacy_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO pharmacy_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pharmacy_app;

-- Revoke DELETE and TRUNCATE from all tables
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM pharmacy_app;

-- Grant DELETE strictly on refresh_tokens and hold_bill_items
GRANT DELETE ON refresh_tokens TO pharmacy_app;
GRANT DELETE ON hold_bill_items TO pharmacy_app;

-- 4. Purchases table: Add void audit columns and constraints
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS void_reason TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ;

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS chk_purchases_void;
ALTER TABLE purchases ADD CONSTRAINT chk_purchases_void CHECK (
    status <> 'voided' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
);

-- Trigger to prevent modifying or un-voiding already voided purchases
CREATE OR REPLACE FUNCTION protect_purchases_voided_state()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
        RAISE EXCEPTION 'A voided purchase cannot be un-voided';
    END IF;
    IF OLD.status = 'voided' AND OLD.* IS DISTINCT FROM NEW.* THEN
        RAISE EXCEPTION 'A voided purchase cannot be modified';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_purchases_protect_voided ON purchases;
CREATE TRIGGER trg_purchases_protect_voided
    BEFORE UPDATE ON purchases
    FOR EACH ROW
    EXECUTE FUNCTION protect_purchases_voided_state();

-- Ensure inventory_settings key exists in settings
INSERT INTO settings (key, value, description, updated_at)
VALUES (
    'inventory_settings',
    '{"max_unapproved_adjustment_cost": 5000.00, "expiry_warning_days": 90}',
    'Inventory threshold and expiry warning settings',
    NOW()
)
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DROP TRIGGER IF EXISTS trg_purchases_protect_voided ON purchases;
DROP FUNCTION IF EXISTS protect_purchases_voided_state();

ALTER TABLE purchases DROP CONSTRAINT IF EXISTS chk_purchases_void;
ALTER TABLE purchases DROP COLUMN IF EXISTS voided_at;
ALTER TABLE purchases DROP COLUMN IF EXISTS voided_by;
ALTER TABLE purchases DROP COLUMN IF EXISTS void_reason;

REVOKE DELETE ON hold_bill_items FROM pharmacy_app;
REVOKE DELETE ON refresh_tokens FROM pharmacy_app;

