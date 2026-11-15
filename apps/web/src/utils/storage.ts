import { CartItem, Customer } from '../types/pos.js';

const STORAGE_KEY = 'lanka_pharmacy_pos_cart_v1';

export interface StoredCartState {
  items: CartItem[];
  billDiscount: number;
  customer: Customer | null;
  idempotencyKey: string | null;
  doctorName?: string;
  patientName?: string;
  notes?: string;
}

export function loadCartState(): StoredCartState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        items: [],
        billDiscount: 0,
        customer: null,
        idempotencyKey: null,
        doctorName: '',
        patientName: '',
        notes: ''
      };
    }
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      billDiscount: typeof parsed.billDiscount === 'number' ? parsed.billDiscount : 0,
      customer: parsed.customer || null,
      idempotencyKey: typeof parsed.idempotencyKey === 'string' ? parsed.idempotencyKey : null,
      doctorName: parsed.doctorName || '',
      patientName: parsed.patientName || '',
      notes: parsed.notes || ''
    };
  } catch (e) {
    console.error('Failed to load cart state from sessionStorage', e);
    return {
      items: [],
      billDiscount: 0,
      customer: null,
      idempotencyKey: null,
      doctorName: '',
      patientName: '',
      notes: ''
    };
  }
}

export function saveCartState(state: StoredCartState): void {
  try {
    // Only persist non-sensitive cart parameters (no phone numbers, no tokens)
    const safeData = {
      items: state.items,
      billDiscount: state.billDiscount,
      customer: state.customer
        ? {
            id: state.customer.id,
            name: state.customer.name
          }
        : null,
      idempotencyKey: state.idempotencyKey,
      doctorName: state.doctorName,
      patientName: state.patientName,
      notes: state.notes
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(safeData));
  } catch (e) {
    console.error('Failed to save cart state to sessionStorage', e);
  }
}

export function clearCartState(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error('Failed to clear cart state from sessionStorage', e);
  }
}
