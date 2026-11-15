export interface BatchDetail {
  id: string;
  batchNo: string;
  expiryDate: string;
  mrp: string | number;
  initialQuantity: string | number;
  currentQuantity: string | number;
  isExpired?: boolean;
  costPrice?: string | number; // Only for owner / pharmacist
  supplierName?: string;       // Only for owner / pharmacist
}

export interface ProductSearchResult {
  id: string;
  name: string;
  genericName?: string | null;
  barcode?: string | null;
  category: string;
  unit: string;
  packSize: number;
  isRxRequired: boolean;
  reorderLevel: number;
  isActive: boolean;
  totalStock: number | string;
  expiredQuantity: number | string;
  activeBatchCount: number;
  minMrp: number | string | null;
  maxMrp: number | string | null;
}

export interface CartItem {
  productId: string;
  productName: string;
  genericName?: string | null;
  barcode?: string | null;
  unit: string;
  packSize: number;
  isRxRequired: boolean;
  allowFractionalQty?: boolean;
  quantity: number;
  unitPrice: string; // MRP per unit
  discountType: 'percent' | 'amount';
  discountValue: number; // e.g. 5% or Rs. 10.00
  discountAmount: string; // Calculated discount amount in Rs.
  lineTotal: string; // Gross minus discount
  availableStock: number;
  nearestExpiryDate?: string | null;
  batches?: BatchDetail[];
}

export interface Customer {
  id: string;
  name: string;
  phone?: string | null;
  creditBalance: number | string;
  creditLimit: number | string;
  isActive: boolean;
}

export interface PaymentEntry {
  type: 'cash' | 'card' | 'bank_transfer' | 'credit';
  amount: number;
  referenceNo?: string;
}

export interface CartPreviewTotals {
  grossSubtotal: string;
  lineDiscountsSum: string;
  billDiscount: string;
  billDiscountPercent: string;
  totalDiscount: string;
  totalDiscountPercent: string;
  netSubtotal: string;
  taxRate: number;
  taxAmount: string;
  grandTotal: string;
  itemCount: number;
  totalUnits: string;
}

export interface HoldBillItem {
  id?: string;
  productId: string;
  productName: string;
  genericName?: string | null;
  barcode?: string | null;
  unit: string;
  quantity: number;
  currentMrp: number | string;
  heldPrice?: number | string;
  availableStock: number | string;
  isStockAvailable: boolean;
  priceChanged?: boolean;
}

export interface HoldBill {
  id: string;
  holdNo: string;
  customerName?: string | null;
  customerPhone?: string | null;
  notes?: string | null;
  status: 'held' | 'resumed' | 'discarded';
  itemCount: number;
  estimatedTotal: number | string;
  allStockAvailable?: boolean;
  items?: HoldBillItem[];
  createdAt: string;
}

export interface ReceiptItem {
  id: string;
  productName: string;
  genericName?: string | null;
  batchNo: string;
  expiryDate: string;
  quantity: string | number;
  unitPrice: string | number;
  discountAmount: string | number;
  lineTotal: string | number;
}

export interface ReceiptPayment {
  type: string;
  amount: string | number;
  referenceNo?: string | null;
}

export interface ReceiptData {
  saleId: string;
  billNo: string;
  createdAt: string;
  cashierName: string;
  customerName?: string | null;
  customerPhone?: string | null;
  patientName?: string | null;
  doctorName?: string | null;
  notes?: string | null;
  subtotal: string | number;
  discountAmount: string | number;
  taxAmount: string | number;
  totalAmount: string | number;
  paidAmount: string | number;
  tenderedAmount: string | number;
  changeAmount: string | number;
  balanceDue: string | number;
  paymentStatus: string;
  status: string;
  isDuplicate: boolean;
  reprintCount: number;
  items: ReceiptItem[];
  payments: ReceiptPayment[];
  shopDetails: {
    name: string;
    email?: string;
    phone?: string;
    address?: string;
    registrationNo?: string;
  };
  receiptSettings: {
    header?: string;
    tagline?: string;
    footer?: string;
    showBatchNo?: boolean;
    showGenericName?: boolean;
  };
}

export interface SaleSummary {
  id: string;
  billNo: string;
  totalAmount: string | number;
  paidAmount: string | number;
  balanceDue: string | number;
  paymentStatus: string;
  status: 'completed' | 'voided';
  customerName?: string | null;
  cashierName: string;
  itemCount: number;
  createdAt: string;
  voidReason?: string | null;
  voidedAt?: string | null;
}
