-- Up Migration

-- Ensure timezone for database session is Asia/Colombo
SET timezone TO 'Asia/Colombo';

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Reusable immutability trigger function for append-only audit & financial ledger tables
CREATE OR REPLACE FUNCTION prevent_modification_on_append_only_table()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only: UPDATE and DELETE operations are prohibited', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- 1. Settings Table
CREATE TABLE settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('owner', 'pharmacist', 'cashier')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Refresh Tokens Table
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- 4. Audit Logs Table (Append-only)
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    entity VARCHAR(50) NOT NULL,
    entity_id TEXT NOT NULL,
    before_state JSONB,
    after_state JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_entity ON audit_logs(entity, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);

CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_on_append_only_table();

-- 5. Suppliers Table
CREATE TABLE suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(50),
    address TEXT,
    outstanding_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Customers Table
CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    phone VARCHAR(50) UNIQUE,
    credit_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (credit_balance >= 0),
    credit_limit NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (credit_limit >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customers_phone ON customers(phone);

-- 7. Products Table (Stock is strictly derived, pack_size defaults to 1 for smallest sellable unit)
CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    generic_name VARCHAR(255),
    barcode VARCHAR(100) UNIQUE,
    category VARCHAR(100) NOT NULL,
    unit VARCHAR(50) NOT NULL,
    pack_size INT NOT NULL DEFAULT 1 CHECK (pack_size > 0),
    is_rx_required BOOLEAN NOT NULL DEFAULT false,
    reorder_level NUMERIC(12,2) NOT NULL DEFAULT 10.00 CHECK (reorder_level >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_products_name ON products(name);
CREATE INDEX idx_products_generic_name ON products(generic_name);

-- 8. Batches Table (Truth source for inventory, stored in smallest sellable unit)
CREATE TABLE batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    supplier_id UUID REFERENCES suppliers(id) ON DELETE RESTRICT,
    batch_no VARCHAR(100) NOT NULL,
    expiry_date DATE NOT NULL,
    cost_price NUMERIC(12,2) NOT NULL CHECK (cost_price >= 0),
    mrp NUMERIC(12,2) NOT NULL CHECK (mrp >= 0),
    initial_quantity NUMERIC(12,2) NOT NULL CHECK (initial_quantity >= 0),
    current_quantity NUMERIC(12,2) NOT NULL CHECK (current_quantity >= 0),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_batches_product_id ON batches(product_id);
CREATE INDEX idx_batches_fefo ON batches(product_id, expiry_date, current_quantity) 
    WHERE current_quantity > 0 AND is_active = true;
CREATE INDEX idx_batches_expiry ON batches(expiry_date);
CREATE INDEX idx_batches_batch_no ON batches(batch_no);

-- 9. Stock Movements Table (Append-only audit trail for all batch quantity changes)
CREATE TABLE stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN (
        'opening_stock', 'purchase', 'sale', 'sales_return', 'supplier_return', 'adjustment', 'void'
    )),
    qty_change NUMERIC(12,2) NOT NULL,
    ref_type VARCHAR(50) NOT NULL,
    ref_id UUID NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_movements_batch_id ON stock_movements(batch_id);
CREATE INDEX idx_stock_movements_ref ON stock_movements(ref_type, ref_id);
CREATE INDEX idx_stock_movements_created_at ON stock_movements(created_at);

CREATE TRIGGER trg_stock_movements_immutable
    BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_on_append_only_table();

-- 10. Purchases (GRN - Goods Received Note)
CREATE TABLE purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    invoice_no VARCHAR(100) NOT NULL,
    purchase_date DATE NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'voided')),
    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchases_supplier_id ON purchases(supplier_id);
CREATE INDEX idx_purchases_date ON purchases(purchase_date);

-- 11. Purchase Items Table (Append-only snapshot)
CREATE TABLE purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_id UUID NOT NULL REFERENCES purchases(id) ON DELETE RESTRICT,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    batch_no VARCHAR(100) NOT NULL,
    expiry_date DATE NOT NULL,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    cost_price NUMERIC(12,2) NOT NULL CHECK (cost_price >= 0),
    mrp NUMERIC(12,2) NOT NULL CHECK (mrp >= 0),
    line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_batch ON purchase_items(batch_id);

CREATE TRIGGER trg_purchase_items_immutable
    BEFORE UPDATE OR DELETE ON purchase_items
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_on_append_only_table();

-- 12. Supplier Payments Table (Supplier balance settlements)
CREATE TABLE supplier_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'bank_transfer', 'cheque')),
    reference_no VARCHAR(100),
    notes TEXT,
    paid_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id);

-- 13. Customer Payments Table (Credit customer repayments)
CREATE TABLE customer_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('cash', 'card', 'bank_transfer', 'cheque')),
    reference_no VARCHAR(100),
    notes TEXT,
    received_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_customer_payments_customer ON customer_payments(customer_id);

-- 14. Stock Adjustments Table
CREATE TABLE stock_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    adjustment_type VARCHAR(30) NOT NULL CHECK (adjustment_type IN ('damage', 'expired_write_off', 'correction')),
    quantity_change NUMERIC(12,2) NOT NULL CHECK (quantity_change != 0),
    reason TEXT NOT NULL,
    adjusted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stock_adj_batch ON stock_adjustments(batch_id);

-- 15. Bill Sequences Table (Atomic daily sequence counter)
CREATE TABLE bill_sequences (
    sequence_key VARCHAR(50) PRIMARY KEY,
    current_number INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 16. Sales Table
CREATE TABLE sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_no VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
    has_rx_items BOOLEAN NOT NULL DEFAULT false,
    subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    discount_percent NUMERIC(5,2) DEFAULT 0.00,
    tax_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (tax_amount >= 0),
    total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    paid_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (paid_amount >= 0),
    change_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (change_amount >= 0),
    balance_due NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (balance_due >= 0),
    payment_status VARCHAR(20) NOT NULL CHECK (payment_status IN ('paid', 'partial', 'credit')),
    status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
    doctor_name VARCHAR(100),
    patient_name VARCHAR(100),
    notes TEXT,
    cashier_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    void_reason TEXT,
    voided_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    voided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_sales_rx CHECK (
        NOT has_rx_items OR (doctor_name IS NOT NULL AND patient_name IS NOT NULL)
    ),
    CONSTRAINT chk_sales_void CHECK (
        status <> 'voided' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)
    ),
    CONSTRAINT chk_sales_total_calc CHECK (
        total_amount = (subtotal - discount_amount + tax_amount)
    ),
    CONSTRAINT chk_sales_balance_calc CHECK (
        balance_due = (total_amount - paid_amount)
    ),
    CONSTRAINT chk_sales_payment_consistency CHECK (
        (payment_status = 'paid' AND balance_due = 0) OR
        (payment_status = 'partial' AND balance_due > 0 AND paid_amount > 0) OR
        (payment_status = 'credit' AND balance_due = total_amount AND paid_amount = 0)
    )
);

CREATE INDEX idx_sales_bill_no ON sales(bill_no);
CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE INDEX idx_sales_customer_id ON sales(customer_id);

-- 17. Sale Items Table (Append-only snapshot)
CREATE TABLE sale_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    unit_cost_price NUMERIC(12,2) NOT NULL CHECK (unit_cost_price >= 0),
    unit_selling_price NUMERIC(12,2) NOT NULL CHECK (unit_selling_price >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00 CHECK (discount_amount >= 0),
    line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sale_items_sale_id ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product_id ON sale_items(product_id);
CREATE INDEX idx_sale_items_batch_id ON sale_items(batch_id);

CREATE TRIGGER trg_sale_items_immutable
    BEFORE UPDATE OR DELETE ON sale_items
    FOR EACH ROW
    EXECUTE FUNCTION prevent_modification_on_append_only_table();

-- 18. Payments Table (Actual cash/card payments received; credit is tracked via balance_due and customer ledger)
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    payment_type VARCHAR(20) NOT NULL CHECK (payment_type IN ('cash', 'card', 'bank_transfer')),
    amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    reference_no VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_sale_id ON payments(sale_id);
CREATE INDEX idx_payments_type ON payments(payment_type);

-- 19. Hold Bills Table
CREATE TABLE hold_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hold_reference VARCHAR(50) UNIQUE NOT NULL,
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(100),
    doctor_name VARCHAR(100),
    patient_name VARCHAR(100),
    notes TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'resumed', 'discarded')),
    held_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 20. Hold Bill Items Table
CREATE TABLE hold_bill_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hold_bill_id UUID NOT NULL REFERENCES hold_bills(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    batch_id UUID REFERENCES batches(id) ON DELETE RESTRICT,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
    discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hold_items_bill_id ON hold_bill_items(hold_bill_id);

-- 21. Sales Returns Table
CREATE TABLE sales_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
    return_no VARCHAR(50) UNIQUE NOT NULL,
    refund_amount NUMERIC(12,2) NOT NULL CHECK (refund_amount >= 0),
    refund_payment_type VARCHAR(20) NOT NULL CHECK (refund_payment_type IN ('cash', 'card', 'credit')),
    reason TEXT NOT NULL,
    processed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sales_returns_original ON sales_returns(original_sale_id);

-- 22. Sales Return Items Table
CREATE TABLE sales_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_return_id UUID NOT NULL REFERENCES sales_returns(id) ON DELETE RESTRICT,
    sale_item_id UUID NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    refund_unit_price NUMERIC(12,2) NOT NULL CHECK (refund_unit_price >= 0),
    line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_return_items_return_id ON sales_return_items(sales_return_id);

-- 23. Supplier Returns Table
CREATE TABLE supplier_returns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    original_purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
    return_no VARCHAR(50) UNIQUE NOT NULL,
    total_amount NUMERIC(12,2) NOT NULL CHECK (total_amount >= 0),
    reason TEXT NOT NULL,
    processed_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supplier_returns_supplier ON supplier_returns(supplier_id);

-- 24. Supplier Return Items Table
CREATE TABLE supplier_return_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_return_id UUID NOT NULL REFERENCES supplier_returns(id) ON DELETE RESTRICT,
    batch_id UUID NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
    quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0),
    line_total NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supp_ret_items_return ON supplier_return_items(supplier_return_id);

-- 25. Day-End Closes Table
CREATE TABLE day_end_closes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_date DATE UNIQUE NOT NULL,
    opening_cash NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    closing_cash NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    cash_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    card_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    credit_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    total_sales NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    cash_in NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    cash_out NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    cash_discrepancy NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    notes TEXT,
    closed_by UUID REFERENCES users(id) ON DELETE RESTRICT,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_day_end_business_date ON day_end_closes(business_date);


-- Down Migration

DROP TABLE IF EXISTS day_end_closes CASCADE;
DROP TABLE IF EXISTS supplier_return_items CASCADE;
DROP TABLE IF EXISTS supplier_returns CASCADE;
DROP TABLE IF EXISTS sales_return_items CASCADE;
DROP TABLE IF EXISTS sales_returns CASCADE;
DROP TABLE IF EXISTS hold_bill_items CASCADE;
DROP TABLE IF EXISTS hold_bills CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS sale_items CASCADE;
DROP TABLE IF EXISTS sales CASCADE;
DROP TABLE IF EXISTS bill_sequences CASCADE;
DROP TABLE IF EXISTS stock_adjustments CASCADE;
DROP TABLE IF EXISTS customer_payments CASCADE;
DROP TABLE IF EXISTS supplier_payments CASCADE;
DROP TABLE IF EXISTS purchase_items CASCADE;
DROP TABLE IF EXISTS purchases CASCADE;
DROP TABLE IF EXISTS stock_movements CASCADE;
DROP TABLE IF EXISTS batches CASCADE;
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS customers CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS settings CASCADE;

DROP FUNCTION IF EXISTS prevent_modification_on_append_only_table CASCADE;
