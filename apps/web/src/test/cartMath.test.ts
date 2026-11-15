import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatNumber,
  calculateItemLine,
  calculateCartTotals,
  isDiscountAllowed,
  calculateCashChange,
  ROLE_DISCOUNT_LIMITS
} from '../utils/cartMath.js';
import { CartItem } from '../types/pos.js';

describe('POS Billing Preview Financial Math (Decimal.js)', () => {
  it('formats monetary amounts with currency symbol and thousands separators (Rs. 1,234.50)', () => {
    expect(formatMoney(0)).toBe('Rs. 0.00');
    expect(formatMoney('0.00')).toBe('Rs. 0.00');
    expect(formatMoney(1234.5)).toBe('Rs. 1,234.50');
    expect(formatMoney('9876543.21')).toBe('Rs. 9,876,543.21');
    expect(formatMoney(null)).toBe('Rs. 0.00');
    expect(formatMoney(undefined)).toBe('Rs. 0.00');
  });

  it('formats numbers without currency prefix (1,234.50)', () => {
    expect(formatNumber(1234.5)).toBe('1,234.50');
    expect(formatNumber('500.00')).toBe('500.00');
    expect(formatNumber(null)).toBe('0.00');
  });

  it('calculates single line items with percent and fixed amount discounts', () => {
    // 10 units @ Rs. 45.00 with 10% discount
    const resPercent = calculateItemLine(10, '45.00', 'percent', 10);
    expect(resPercent.gross).toBe('450.00');
    expect(resPercent.discountAmount).toBe('45.00');
    expect(resPercent.lineTotal).toBe('405.00');

    // 3 units @ Rs. 100.00 with Rs. 25.00 flat discount
    const resAmount = calculateItemLine(3, '100.00', 'amount', 25);
    expect(resAmount.gross).toBe('300.00');
    expect(resAmount.discountAmount).toBe('25.00');
    expect(resAmount.lineTotal).toBe('275.00');

    // Discount cannot exceed gross amount
    const resCapped = calculateItemLine(1, '50.00', 'amount', 100);
    expect(resCapped.discountAmount).toBe('50.00');
    expect(resCapped.lineTotal).toBe('0.00');
  });

  it('computes running cart totals preview with zero floating point drift', () => {
    const items: CartItem[] = [
      {
        productId: 'prod-1',
        productName: 'Amoxicillin 500mg',
        unit: 'capsule',
        packSize: 10,
        isRxRequired: false,
        quantity: 10,
        unitPrice: '45.00',
        discountType: 'percent',
        discountValue: 10,
        discountAmount: '45.00',
        lineTotal: '405.00',
        availableStock: 100
      },
      {
        productId: 'prod-2',
        productName: 'Paracetamol 500mg',
        unit: 'tablet',
        packSize: 1,
        isRxRequired: false,
        quantity: 20,
        unitPrice: '5.50',
        discountType: 'amount',
        discountValue: 10.0,
        discountAmount: '10.00',
        lineTotal: '100.00',
        availableStock: 500
      }
    ];

    // Gross: (10 * 45) + (20 * 5.50) = 450.00 + 110.00 = 560.00
    // Line discounts: 45.00 + 10.00 = 55.00
    // Net Subtotal: 560.00 - 55.00 = 505.00
    // Bill discount: 5.00
    // Grand Total: 505.00 - 5.00 = 500.00
    const totals = calculateCartTotals(items, 5.0, 0);

    expect(totals.grossSubtotal).toBe('560.00');
    expect(totals.lineDiscountsSum).toBe('55.00');
    expect(totals.billDiscount).toBe('5.00');
    expect(totals.totalDiscount).toBe('60.00'); // 55 + 5
    expect(totals.netSubtotal).toBe('505.00');
    expect(totals.grandTotal).toBe('500.00');
    expect(totals.itemCount).toBe(2);
    expect(totals.totalUnits).toBe('30.00');

    // Combined discount percentage: (60 / 560) * 100 = 10.71%
    expect(totals.totalDiscountPercent).toBe('10.71');
  });

  it('correctly calculates tax amount when tax rate is specified', () => {
    const items: CartItem[] = [
      {
        productId: 'prod-1',
        productName: 'Health Supplement',
        unit: 'bottle',
        packSize: 1,
        isRxRequired: false,
        quantity: 1,
        unitPrice: '1000.00',
        discountType: 'percent',
        discountValue: 0,
        discountAmount: '0.00',
        lineTotal: '1000.00',
        availableStock: 10
      }
    ];

    // 1000.00 + 10% tax = 1100.00
    const totals = calculateCartTotals(items, 0, 10.0);
    expect(totals.grossSubtotal).toBe('1000.00');
    expect(totals.taxAmount).toBe('100.00');
    expect(totals.grandTotal).toBe('1100.00');
  });

  it('evaluates role-based discount limits strictly', () => {
    expect(ROLE_DISCOUNT_LIMITS.cashier).toBe(5.0);
    expect(ROLE_DISCOUNT_LIMITS.pharmacist).toBe(15.0);
    expect(ROLE_DISCOUNT_LIMITS.owner).toBe(100.0);

    // Cashier: max 5%
    expect(isDiscountAllowed('cashier', 4.99).allowed).toBe(true);
    expect(isDiscountAllowed('cashier', 5.0).allowed).toBe(true);
    expect(isDiscountAllowed('cashier', 5.01).allowed).toBe(false);

    // Pharmacist: max 15%
    expect(isDiscountAllowed('pharmacist', 14.5).allowed).toBe(true);
    expect(isDiscountAllowed('pharmacist', 15.0).allowed).toBe(true);
    expect(isDiscountAllowed('pharmacist', 15.1).allowed).toBe(false);

    // Owner: up to 100%
    expect(isDiscountAllowed('owner', 99.9).allowed).toBe(true);
    expect(isDiscountAllowed('owner', 100.0).allowed).toBe(true);
  });

  it('computes cash change accurately without negative amounts', () => {
    expect(calculateCashChange(1000, 800)).toBe('200.00');
    expect(calculateCashChange('500.00', '500.00')).toBe('0.00');
    expect(calculateCashChange(400, 500)).toBe('0.00'); // No negative change
  });
});
