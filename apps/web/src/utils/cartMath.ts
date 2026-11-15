import Decimal from 'decimal.js';
import { CartItem, CartPreviewTotals } from '../types/pos.js';
import { UserRole } from '../types/auth.js';

export const ROLE_DISCOUNT_LIMITS: Record<UserRole, number> = {
  cashier: 5.0,
  pharmacist: 15.0,
  owner: 100.0
};

/**
 * Formats monetary amounts as "Rs. 1,234.50"
 */
export function formatMoney(amount: number | string | Decimal | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') {
    return 'Rs. 0.00';
  }
  try {
    const dec = new Decimal(amount);
    const parts = dec.toFixed(2).split('.');
    const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `Rs. ${integerPart}.${parts[1]}`;
  } catch {
    return 'Rs. 0.00';
  }
}

/**
 * Formats a plain numeric string like "1,234.50" without currency prefix
 */
export function formatNumber(amount: number | string | Decimal | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') {
    return '0.00';
  }
  try {
    const dec = new Decimal(amount);
    const parts = dec.toFixed(2).split('.');
    const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${integerPart}.${parts[1]}`;
  } catch {
    return '0.00';
  }
}

/**
 * Computes single item discount amount and line total using Decimal.js
 */
export function calculateItemLine(
  quantity: number | string,
  unitPrice: number | string,
  discountType: 'percent' | 'amount' = 'amount',
  discountValue: number | string = 0
): { discountAmount: string; lineTotal: string; gross: string } {
  const qty = new Decimal(quantity || 0);
  const price = new Decimal(unitPrice || 0);
  const gross = qty.times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  let discountDec = new Decimal(0);
  const discVal = new Decimal(discountValue || 0);

  if (discountType === 'percent') {
    discountDec = gross.times(discVal.dividedBy(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  } else {
    discountDec = Decimal.min(gross, discVal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  // Ensure discount does not exceed gross
  discountDec = Decimal.min(gross, discountDec);
  const lineTotal = gross.minus(discountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  return {
    discountAmount: discountDec.toFixed(2),
    lineTotal: lineTotal.toFixed(2),
    gross: gross.toFixed(2)
  };
}

/**
 * Computes running cart preview totals strictly using Decimal.js
 */
export function calculateCartTotals(
  items: CartItem[],
  billDiscount: number | string = 0,
  taxRate: number = 0
): CartPreviewTotals {
  let grossSum = new Decimal(0);
  let lineDiscountsSum = new Decimal(0);
  let totalUnits = new Decimal(0);

  for (const item of items) {
    const qty = new Decimal(item.quantity || 0);
    const price = new Decimal(item.unitPrice || 0);
    const lineGross = qty.times(price).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const lineDiscount = new Decimal(item.discountAmount || 0);

    grossSum = grossSum.plus(lineGross);
    lineDiscountsSum = lineDiscountsSum.plus(lineDiscount);
    totalUnits = totalUnits.plus(qty);
  }

  const billDiscountDec = new Decimal(billDiscount || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const netSubtotal = Decimal.max(0, grossSum.minus(lineDiscountsSum)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  // Total combined discount (line discounts + bill discount)
  const totalDiscount = lineDiscountsSum.plus(billDiscountDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  // Discount % of gross
  const totalDiscountPercent = grossSum.gt(0)
    ? totalDiscount.times(100).dividedBy(grossSum).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  const billDiscountPercent = grossSum.gt(0)
    ? billDiscountDec.times(100).dividedBy(grossSum).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : new Decimal(0);

  // Tax calculation
  const taxRateDec = new Decimal(taxRate || 0);
  const taxableBase = Decimal.max(0, netSubtotal.minus(billDiscountDec));
  const taxAmount = taxableBase.times(taxRateDec.dividedBy(100)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const grandTotal = Decimal.max(0, netSubtotal.minus(billDiscountDec).plus(taxAmount)).toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP
  );

  return {
    grossSubtotal: grossSum.toFixed(2),
    lineDiscountsSum: lineDiscountsSum.toFixed(2),
    billDiscount: billDiscountDec.toFixed(2),
    billDiscountPercent: billDiscountPercent.toFixed(2),
    totalDiscount: totalDiscount.toFixed(2),
    totalDiscountPercent: totalDiscountPercent.toFixed(2),
    netSubtotal: netSubtotal.toFixed(2),
    taxRate,
    taxAmount: taxAmount.toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    itemCount: items.length,
    totalUnits: totalUnits.toFixed(2)
  };
}

/**
 * Validates whether the combined discount percentage complies with the user role limit
 */
export function isDiscountAllowed(
  role: UserRole,
  combinedDiscountPercent: number | string | Decimal
): { allowed: boolean; maxAllowed: number; current: number } {
  const maxLimit = ROLE_DISCOUNT_LIMITS[role] ?? 5.0;
  const current = new Decimal(combinedDiscountPercent || 0).toNumber();
  return {
    allowed: current <= maxLimit + 0.001, // floating safety margin
    maxAllowed: maxLimit,
    current
  };
}

/**
 * Computes change preview for cash tendered
 */
export function calculateCashChange(
  tendered: number | string,
  totalPaidApplied: number | string
): string {
  const t = new Decimal(tendered || 0);
  const p = new Decimal(totalPaidApplied || 0);
  return Decimal.max(0, t.minus(p)).toFixed(2);
}
