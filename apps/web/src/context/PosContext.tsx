import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { CartItem, Customer, CartPreviewTotals, ProductSearchResult, HoldBill } from '../types/pos.js';
import { calculateCartTotals, calculateItemLine } from '../utils/cartMath.js';
import { loadCartState, saveCartState, clearCartState } from '../utils/storage.js';
import { api } from '../utils/api.js';

interface PosContextType {
  items: CartItem[];
  customer: Customer | null;
  billDiscount: number;
  doctorName: string;
  patientName: string;
  notes: string;
  idempotencyKey: string | null;
  totals: CartPreviewTotals;
  taxRate: number;
  hasRxItems: boolean;
  addItem: (product: ProductSearchResult, quantity?: number) => Promise<{ success: boolean; message?: string }>;
  updateItemQty: (productId: string, newQty: number) => { success: boolean; message?: string };
  updateItemDiscount: (productId: string, discountType: 'percent' | 'amount', discountValue: number) => void;
  removeItem: (productId: string) => void;
  setBillDiscount: (amount: number) => void;
  setCustomer: (customer: Customer | null) => void;
  setRxDetails: (doctor: string, patient: string) => void;
  setNotes: (notes: string) => void;
  clearCart: () => void;
  getOrCreateIdempotencyKey: () => string;
  resetIdempotencyKey: () => void;
  loadHeldBillIntoCart: (holdBill: HoldBill) => void;
  priceChangeWarning: string | null;
  setPriceChangeWarning: (w: string | null) => void;
}

const PosContext = createContext<PosContextType | undefined>(undefined);

export const PosProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initial = useMemo(() => loadCartState(), []);

  const [items, setItems] = useState<CartItem[]>(initial.items);
  const [customer, setCustomerState] = useState<Customer | null>(initial.customer);
  const [billDiscount, setBillDiscountState] = useState<number>(initial.billDiscount);
  const [doctorName, setDoctorNameState] = useState<string>(initial.doctorName || '');
  const [patientName, setPatientNameState] = useState<string>(initial.patientName || '');
  const [notes, setNotesState] = useState<string>(initial.notes || '');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(initial.idempotencyKey);
  const [taxRate] = useState<number>(0.0); // Can be loaded from system settings
  const [priceChangeWarning, setPriceChangeWarning] = useState<string | null>(null);

  // Invalidate idempotency key whenever cart content changes
  const invalidateIdempotencyKey = useCallback(() => {
    setIdempotencyKey(null);
  }, []);

  // Save to sessionStorage whenever cart changes
  useEffect(() => {
    saveCartState({
      items,
      billDiscount,
      customer,
      idempotencyKey,
      doctorName,
      patientName,
      notes
    });
  }, [items, billDiscount, customer, idempotencyKey, doctorName, patientName, notes]);

  // Running totals preview strictly using Decimal.js
  const totals = useMemo(() => {
    return calculateCartTotals(items, billDiscount, taxRate);
  }, [items, billDiscount, taxRate]);

  const hasRxItems = useMemo(() => {
    return items.some((i) => i.isRxRequired);
  }, [items]);

  const getOrCreateIdempotencyKey = useCallback((): string => {
    if (idempotencyKey) {
      return idempotencyKey;
    }
    const newKey = crypto.randomUUID();
    setIdempotencyKey(newKey);
    return newKey;
  }, [idempotencyKey]);

  const resetIdempotencyKey = useCallback(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, []);

  const addItem = useCallback(
    async (product: ProductSearchResult, quantity: number = 1): Promise<{ success: boolean; message?: string }> => {
      const availableStock = Number(product.totalStock || 0);
      if (availableStock <= 0) {
        return { success: false, message: `Product '${product.name}' is out of stock.` };
      }

      // Check if already in cart
      const existingIndex = items.findIndex((i) => i.productId === product.id);
      if (existingIndex >= 0) {
        const current = items[existingIndex];
        const nextQty = current.quantity + quantity;
        if (nextQty > availableStock) {
          return {
            success: false,
            message: `Cannot add more. Only ${availableStock} units available in stock.`
          };
        }

        const calculated = calculateItemLine(nextQty, current.unitPrice, current.discountType, current.discountValue);
        const updated = [...items];
        updated[existingIndex] = {
          ...current,
          quantity: nextQty,
          discountAmount: calculated.discountAmount,
          lineTotal: calculated.lineTotal
        };

        setItems(updated);
        invalidateIdempotencyKey();
        return { success: true };
      }

      // Fetch fresh details with active batches from server
      let nearestExpiry: string | null = null;
      let unitPrice = '0.00';
      let batches: any[] = [];
      let allowFractionalQty = false;

      try {
        const prodRes = await api.get<{ product: any }>(`/products/${product.id}`);
        const p = prodRes?.product;
        if (p) {
          allowFractionalQty = Boolean(p.allowFractionalQty || p.allow_fractional_qty);
          batches = p.batches || [];

          // Nearest expiry among non-expired batches
          const validBatches = batches.filter((b: any) => !b.isExpired && Number(b.currentQuantity) > 0);
          if (validBatches.length > 0) {
            nearestExpiry = validBatches[0].expiryDate;
            unitPrice = String(validBatches[0].mrp);
          } else if (p.minMrp) {
            unitPrice = String(p.minMrp);
          }
        } else if (product.minMrp) {
          unitPrice = String(product.minMrp);
        }
      } catch (err) {
        console.warn('Failed to fetch full product details, falling back to search summary:', err);
        unitPrice = product.minMrp ? String(product.minMrp) : '0.00';
      }

      const initialQty = Math.min(quantity, availableStock);
      const calculated = calculateItemLine(initialQty, unitPrice, 'percent', 0);

      const newItem: CartItem = {
        productId: product.id,
        productName: product.name,
        genericName: product.genericName,
        barcode: product.barcode,
        unit: product.unit,
        packSize: product.packSize || 1,
        isRxRequired: product.isRxRequired,
        allowFractionalQty,
        quantity: initialQty,
        unitPrice,
        discountType: 'percent',
        discountValue: 0,
        discountAmount: calculated.discountAmount,
        lineTotal: calculated.lineTotal,
        availableStock,
        nearestExpiryDate: nearestExpiry,
        batches
      };

      setItems((prev) => [...prev, newItem]);
      invalidateIdempotencyKey();
      return { success: true };
    },
    [items, invalidateIdempotencyKey]
  );

  const updateItemQty = useCallback(
    (productId: string, newQty: number): { success: boolean; message?: string } => {
      const idx = items.findIndex((i) => i.productId === productId);
      if (idx < 0) return { success: false, message: 'Item not in cart' };

      const item = items[idx];
      if (newQty <= 0) {
        // Remove item if quantity reduced to 0
        setItems((prev) => prev.filter((i) => i.productId !== productId));
        invalidateIdempotencyKey();
        return { success: true };
      }

      if (!item.allowFractionalQty && !Number.isInteger(newQty)) {
        return { success: false, message: `Product '${item.productName}' requires integer quantity.` };
      }

      if (newQty > item.availableStock) {
        return {
          success: false,
          message: `Requested quantity (${newQty}) exceeds available stock (${item.availableStock}).`
        };
      }

      const calculated = calculateItemLine(newQty, item.unitPrice, item.discountType, item.discountValue);
      const updated = [...items];
      updated[idx] = {
        ...item,
        quantity: newQty,
        discountAmount: calculated.discountAmount,
        lineTotal: calculated.lineTotal
      };

      setItems(updated);
      invalidateIdempotencyKey();
      return { success: true };
    },
    [items, invalidateIdempotencyKey]
  );

  const updateItemDiscount = useCallback(
    (productId: string, discountType: 'percent' | 'amount', discountValue: number) => {
      const idx = items.findIndex((i) => i.productId === productId);
      if (idx < 0) return;

      const item = items[idx];
      const safeVal = Math.max(0, discountValue);
      const calculated = calculateItemLine(item.quantity, item.unitPrice, discountType, safeVal);

      const updated = [...items];
      updated[idx] = {
        ...item,
        discountType,
        discountValue: safeVal,
        discountAmount: calculated.discountAmount,
        lineTotal: calculated.lineTotal
      };

      setItems(updated);
      invalidateIdempotencyKey();
    },
    [items, invalidateIdempotencyKey]
  );

  const removeItem = useCallback(
    (productId: string) => {
      setItems((prev) => prev.filter((i) => i.productId !== productId));
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  const setBillDiscount = useCallback(
    (amount: number) => {
      setBillDiscountState(Math.max(0, amount));
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  const setCustomer = useCallback(
    (c: Customer | null) => {
      setCustomerState(c);
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  const setRxDetails = useCallback(
    (doctor: string, patient: string) => {
      setDoctorNameState(doctor);
      setPatientNameState(patient);
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  const setNotes = useCallback(
    (n: string) => {
      setNotesState(n);
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  const clearCart = useCallback(() => {
    setItems([]);
    setCustomerState(null);
    setBillDiscountState(0);
    setDoctorNameState('');
    setPatientNameState('');
    setNotesState('');
    setIdempotencyKey(null);
    clearCartState();
  }, []);

  const loadHeldBillIntoCart = useCallback(
    (holdBill: HoldBill) => {
      if (!holdBill.items || holdBill.items.length === 0) return;

      const newItems: CartItem[] = holdBill.items.map((hi) => {
        const qty = Number(hi.quantity);
        const price = String(hi.currentMrp);
        const calculated = calculateItemLine(qty, price, 'percent', 0);

        return {
          productId: hi.productId,
          productName: hi.productName,
          genericName: hi.genericName,
          barcode: hi.barcode,
          unit: hi.unit,
          packSize: 1,
          isRxRequired: false,
          allowFractionalQty: false,
          quantity: qty,
          unitPrice: price,
          discountType: 'percent',
          discountValue: 0,
          discountAmount: calculated.discountAmount,
          lineTotal: calculated.lineTotal,
          availableStock: Number(hi.availableStock || 0)
        };
      });

      setItems(newItems);

      const changedItems = holdBill.items.filter((hi) => hi.priceChanged);
      if (changedItems.length > 0) {
        setPriceChangeWarning(
          `Price update warning: Retail prices have changed since this bill was held for: ${changedItems.map((i) => `${i.productName} (held: Rs. ${Number(i.heldPrice || 0).toFixed(2)}, current: Rs. ${Number(i.currentMrp).toFixed(2)})`).join(', ')}.`
        );
      } else {
        setPriceChangeWarning(null);
      }

      if (holdBill.customerName) {
        setCustomerState({
          id: '',
          name: holdBill.customerName,
          phone: holdBill.customerPhone || null,
          creditBalance: 0,
          creditLimit: 0,
          isActive: true
        });
      }
      setNotesState(holdBill.notes || '');
      invalidateIdempotencyKey();
    },
    [invalidateIdempotencyKey]
  );

  return (
    <PosContext.Provider
      value={{
        items,
        customer,
        billDiscount,
        doctorName,
        patientName,
        notes,
        idempotencyKey,
        totals,
        taxRate,
        hasRxItems,
        addItem,
        updateItemQty,
        updateItemDiscount,
        removeItem,
        setBillDiscount,
        setCustomer,
        setRxDetails,
        setNotes,
        clearCart,
        getOrCreateIdempotencyKey,
        resetIdempotencyKey,
        loadHeldBillIntoCart,
        priceChangeWarning,
        setPriceChangeWarning
      }}
    >
      {children}
    </PosContext.Provider>
  );
};

export function usePos() {
  const ctx = useContext(PosContext);
  if (!ctx) {
    throw new Error('usePos must be used within a PosProvider');
  }
  return ctx;
}
