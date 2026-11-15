import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaymentDialog } from '../components/PaymentDialog.js';
import { PosProvider, usePos } from '../context/PosContext.js';
import * as AuthModule from '../context/AuthContext.js';
import { api } from '../utils/api.js';

const CartPopulator: React.FC<{
  product: any;
  customer?: any;
  onReady?: () => void;
}> = ({ product, customer, onReady }) => {
  const { addItem, setCustomer } = usePos();

  React.useEffect(() => {
    (async () => {
      if (customer) {
        setCustomer(customer);
      }
      await addItem(product, 2); // 2 units * 250 = 500
      if (onReady) onReady();
    })();
  }, []);

  return null;
};

describe('Store Credit Tender & Partial Payment Client Invariants', () => {
  const dummyProduct = {
    id: 'prod-credit-1',
    name: 'Metformin 500mg',
    category: 'Diabetes',
    unit: 'tablet',
    packSize: 1,
    isRxRequired: false,
    reorderLevel: 10,
    isActive: true,
    totalStock: 100,
    expiredQuantity: 0,
    activeBatchCount: 1,
    minMrp: 250,
    maxMrp: 250
  };

  const registeredCustomer = {
    id: 'cust-uuid-1',
    name: 'Nimal Jayawardena',
    phone: '0771234567',
    creditLimit: 50000,
    creditBalance: 1500,
    isActive: true
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    vi.spyOn(AuthModule, 'useAuth').mockReturnValue({
      user: { id: 'u1', username: 'cashier', fullName: 'Cashier User', role: 'cashier', isActive: true },
      token: 'mock-token',
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      checkAuth: vi.fn()
    });

    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/products/')) {
        return {
          product: {
            id: 'prod-credit-1',
            name: 'Metformin 500mg',
            minMrp: 250,
            allowFractionalQty: false,
            batches: []
          }
        };
      }
      return {
        saleId: 'sale-credit-1',
        billNo: 'INV-20261115-0001',
        createdAt: new Date().toISOString(),
        cashierName: 'Cashier User',
        subtotal: 500,
        totalAmount: 500,
        paidAmount: 0,
        tenderedAmount: 0,
        changeAmount: 0,
        balanceDue: 500,
        items: [],
        payments: []
      };
    });
  });

  it('blocks credit sale when walk-in customer is selected (no customer)', async () => {
    let isReady = false;

    render(
      <PosProvider>
        <CartPopulator product={dummyProduct} customer={null} onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
      </PosProvider>
    );

    await waitFor(() => expect(isReady).toBe(true));

    // 1. In single payment mode, Credit button is hard-disabled for walk-in customer
    const creditBtn = screen.getByRole('button', { name: /^Credit$/i });
    expect(creditBtn).toBeDisabled();

    // 2. In split payment mode with an outstanding balance, checkout is actively blocked with clear error
    const splitTab = screen.getByRole('button', { name: /Split \/ Partial Payment/i });
    fireEvent.click(splitTab);

    // Set cash payment to 200 (leaving 300 balance due without a customer)
    const amountInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(amountInputs[0], { target: { value: '200' } });

    // Click Confirm & Print Receipt
    const confirmBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(confirmBtn);

    // Assert validation error appears and prevents checkout
    await waitFor(() => {
      expect(screen.getByText(/registered customer is required for credit/i)).toBeInTheDocument();
    });
  });

  it('sends ZERO payment rows in request body for full Store Credit sale, deriving balanceDue on server', async () => {
    let capturedPayload: any = null;
    let isReady = false;

    vi.spyOn(api, 'post').mockImplementation(async (url: string, payload?: any) => {
      if (url === '/sales') {
        capturedPayload = payload;
        return {
          sale: {
            id: 'sale-credit-1',
            totalAmount: 500,
            paidAmount: 0,
            balanceDue: 500,
            paymentStatus: 'credit'
          }
        };
      }
      return {};
    });

    render(
      <PosProvider>
        <CartPopulator product={dummyProduct} customer={registeredCustomer} onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
      </PosProvider>
    );

    await waitFor(() => expect(isReady).toBe(true));

    // Select Credit tender (enabled because customer is registered)
    const creditBtn = screen.getByRole('button', { name: /^Credit$/i });
    expect(creditBtn).toBeEnabled();
    fireEvent.click(creditBtn);

    // Confirm checkout
    const confirmBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(capturedPayload).not.toBeNull());

    // CRITICAL ASSERTION: Credit must NEVER be sent as a payments row!
    expect(capturedPayload.payments).toEqual([]);
    expect(capturedPayload.payments.some((p: any) => p.type === 'credit')).toBe(false);
    expect(capturedPayload.tenderedAmount).toBe(0);
    expect(capturedPayload.customerId).toBe(registeredCustomer.id);
  });

  it('sends only real tenders (cash) in partial payment sale, with zero credit rows and correct balance_due', async () => {
    let capturedPayload: any = null;
    let isReady = false;

    vi.spyOn(api, 'post').mockImplementation(async (url: string, payload?: any) => {
      if (url === '/sales') {
        capturedPayload = payload;
        return {
          sale: {
            id: 'sale-partial-1',
            totalAmount: 500,
            paidAmount: 200,
            balanceDue: 300,
            paymentStatus: 'partial'
          }
        };
      }
      return {};
    });

    render(
      <PosProvider>
        <CartPopulator product={dummyProduct} customer={registeredCustomer} onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
      </PosProvider>
    );

    await waitFor(() => expect(isReady).toBe(true));

    // Switch to Split / Partial Payment mode
    const splitTab = screen.getByRole('button', { name: /Split \/ Partial Payment/i });
    fireEvent.click(splitTab);

    // Set cash tender to 200 (leaving 300 balance due to store credit)
    const amountInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(amountInputs[0], { target: { value: '200' } });

    // Confirm checkout
    const confirmBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(capturedPayload).not.toBeNull());

    // CRITICAL ASSERTION:
    // Only real tenders sent (cash: 200). Absolutely NO credit row in payments array!
    expect(capturedPayload.payments).toHaveLength(1);
    expect(capturedPayload.payments[0]).toEqual({ type: 'cash', amount: 200 });
    expect(capturedPayload.payments.some((p: any) => p.type === 'credit')).toBe(false);
    expect(capturedPayload.tenderedAmount).toBe(200);
  });
});
