-- Up Migration

-- 1. Update supplier_ledger entry_type check to include 'purchase_void'
ALTER TABLE supplier_ledger DROP CONSTRAINT IF EXISTS supplier_ledger_entry_type_check;
ALTER TABLE supplier_ledger ADD CONSTRAINT supplier_ledger_entry_type_check 
    CHECK (entry_type IN ('purchase_credit', 'payment', 'return_debit', 'adjustment', 'purchase_void'));

-- 2. Case-insensitive invoice uniqueness per supplier for active/received purchases
DROP INDEX IF EXISTS uq_purchases_supplier_invoice_received;
DROP INDEX IF EXISTS uq_purchases_supplier_lower_invoice_received;
CREATE UNIQUE INDEX uq_purchases_supplier_lower_invoice_received 
    ON purchases (supplier_id, lower(invoice_no)) 
    WHERE status = 'received';

-- 3. Update inventory_settings in settings table to include daily limits & thresholds
UPDATE settings 
SET value = jsonb_set(
    jsonb_set(
        jsonb_set(value, '{max_daily_adjustment_cost_per_user}', '10000.00', true),
        '{positive_correction_owner_threshold}', '1000.00', true
    ),
    '{max_unapproved_adjustment_cost}', '5000.00', true
),
updated_at = NOW()
WHERE key = 'inventory_settings';

-- Down Migration

UPDATE settings
SET value = '{"max_unapproved_adjustment_cost": 5000.00, "expiry_warning_days": 90}'::jsonb,
    updated_at = NOW()
WHERE key = 'inventory_settings';

DROP INDEX IF EXISTS uq_purchases_supplier_lower_invoice_received;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchases_supplier_invoice_received 
    ON purchases (supplier_id, invoice_no) 
    WHERE status = 'received';

ALTER TABLE supplier_ledger DROP CONSTRAINT IF EXISTS supplier_ledger_entry_type_check;
ALTER TABLE supplier_ledger ADD CONSTRAINT supplier_ledger_entry_type_check 
    CHECK (entry_type IN ('purchase_credit', 'payment', 'return_debit', 'adjustment'));

