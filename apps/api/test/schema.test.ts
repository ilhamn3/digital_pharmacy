import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Phase 1 DB Schema & Invariants (Static DDL Analysis)', () => {
  let migrationSql: string;
  let upSql: string;
  let downSql: string;

  beforeAll(() => {
    const migrationPath = path.resolve(__dirname, '../../../db/migrations/1700000000001_create_phase1_schema.sql');
    expect(fs.existsSync(migrationPath)).toBe(true);
    migrationSql = fs.readFileSync(migrationPath, 'utf-8');

    // Split into Up and Down migrations
    const parts = migrationSql.split('-- Down Migration');
    expect(parts.length).toBe(2);
    upSql = parts[0].replace('-- Up Migration', '').trim();
    downSql = parts[1].trim();
  });

  it('contains all required Phase 1 tables including financial ledgers and stock_movements', () => {
    const requiredTables = [
      'settings',
      'users',
      'refresh_tokens',
      'audit_logs',
      'suppliers',
      'supplier_payments',
      'customers',
      'customer_payments',
      'products',
      'batches',
      'stock_movements',
      'purchases',
      'purchase_items',
      'stock_adjustments',
      'bill_sequences',
      'sales',
      'sale_items',
      'payments',
      'hold_bills',
      'hold_bill_items',
      'sales_returns',
      'sales_return_items',
      'supplier_returns',
      'supplier_return_items',
      'day_end_closes'
    ];

    for (const table of requiredTables) {
      const regex = new RegExp(`CREATE TABLE\\s+${table}\\b`, 'i');
      expect(upSql).toMatch(regex);
    }
  });

  describe('Stock & Invariant Rules', () => {
    it('enforces non-negative stock check constraint on batches (Hard Rule)', () => {
      expect(upSql).toMatch(/current_quantity NUMERIC\(12,2\)[^;]+CHECK\s*\(current_quantity\s*>=\s*0\)/i);
    });

    it('enforces pack_size on products with check > 0', () => {
      expect(upSql).toMatch(/pack_size INT NOT NULL DEFAULT 1 CHECK \(pack_size > 0\)/i);
    });

    it('enforces stock_movements table with append-only trigger', () => {
      expect(upSql).toMatch(/CREATE TABLE stock_movements/i);
      expect(upSql).toMatch(/trg_stock_movements_immutable/i);
    });

    it('does NOT store a single product-level stock quantity column in products table', () => {
      const productsDefMatch = upSql.match(/CREATE TABLE products\s*\(([\s\S]*?)\);/i);
      expect(productsDefMatch).not.toBeNull();
      const productsDef = productsDefMatch![1];
      expect(productsDef).not.toMatch(/\b(stock|quantity|qty|total_stock|stock_quantity)\b/i);
    });
  });

  describe('Money & Precision Rules', () => {
    it('stores all financial values as NUMERIC(12,2)', () => {
      const moneyDefinitions = [
        'cost_price NUMERIC(12,2)',
        'mrp NUMERIC(12,2)',
        'total_amount NUMERIC(12,2)',
        'subtotal NUMERIC(12,2)',
        'discount_amount NUMERIC(12,2)',
        'tax_amount NUMERIC(12,2)',
        'paid_amount NUMERIC(12,2)',
        'change_amount NUMERIC(12,2)',
        'balance_due NUMERIC(12,2)',
        'unit_cost_price NUMERIC(12,2)',
        'unit_selling_price NUMERIC(12,2)',
        'credit_balance NUMERIC(12,2)',
        'credit_limit NUMERIC(12,2)',
        'outstanding_balance NUMERIC(12,2)',
        'opening_cash NUMERIC(12,2)',
        'closing_cash NUMERIC(12,2)'
      ];

      for (const def of moneyDefinitions) {
        expect(upSql).toContain(def);
      }
    });

    it('removes credit from payments.payment_type (credit is balance_due, not cash received)', () => {
      const paymentsMatch = upSql.match(/CREATE TABLE payments\s*\(([\s\S]*?)\);/i);
      expect(paymentsMatch).not.toBeNull();
      const paymentsDef = paymentsMatch![1];
      expect(paymentsDef).toMatch(/CHECK\s*\(\s*payment_type\s+IN\s*\('cash',\s*'card',\s*'bank_transfer'\)\)/i);
    });
  });

  describe('Indexing & Concurrency Strategy', () => {
    it('creates FEFO index on batches with active stock predicate', () => {
      expect(upSql).toMatch(/CREATE INDEX idx_batches_fefo ON batches\s*\(\s*product_id,\s*expiry_date,\s*current_quantity\s*\)\s*WHERE current_quantity > 0 AND is_active = true;/i);
    });

    it('creates barcode index with IS NOT NULL predicate', () => {
      expect(upSql).toMatch(/CREATE INDEX idx_products_barcode ON products\(barcode\)\s*WHERE barcode IS NOT NULL;/i);
    });

    it('creates gap-free sequential bill sequences table', () => {
      expect(upSql).toMatch(/CREATE TABLE bill_sequences\s*\(\s*sequence_key VARCHAR\(50\) PRIMARY KEY,\s*current_number INT NOT NULL DEFAULT 0/i);
    });
  });

  describe('Audit Logging & Immutability', () => {
    it('sets audit_logs.entity_id to TEXT and attaches immutability trigger', () => {
      expect(upSql).toMatch(/entity_id TEXT NOT NULL/i);
      expect(upSql).toMatch(/trg_audit_logs_immutable/i);
    });

    it('attaches immutability triggers to sale_items, purchase_items, and stock_movements', () => {
      expect(upSql).toMatch(/trg_sale_items_immutable/i);
      expect(upSql).toMatch(/trg_purchase_items_immutable/i);
      expect(upSql).toMatch(/trg_stock_movements_immutable/i);
    });
  });

  describe('Sales Constraints', () => {
    it('enforces Rx constraints on sales (doctor and patient required if has_rx_items)', () => {
      expect(upSql).toContain('CONSTRAINT chk_sales_rx CHECK');
      expect(upSql).toMatch(/NOT has_rx_items OR \(\s*doctor_name IS NOT NULL AND patient_name IS NOT NULL\s*\)/);
    });

    it('enforces void audit constraints on sales', () => {
      expect(upSql).toContain('CONSTRAINT chk_sales_void CHECK');
      expect(upSql).toMatch(/status <> 'voided' OR \(\s*void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL\s*\)/);
    });

    it('enforces total calculation and payment consistency checks on sales', () => {
      expect(upSql).toContain('CONSTRAINT chk_sales_total_calc CHECK');
      expect(upSql).toMatch(/total_amount = \(subtotal - discount_amount \+ tax_amount\)/);
      expect(upSql).toContain('CONSTRAINT chk_sales_balance_calc CHECK');
      expect(upSql).toMatch(/balance_due = \(total_amount - paid_amount\)/);
      expect(upSql).toContain('CONSTRAINT chk_sales_payment_consistency CHECK');
    });
  });
});
