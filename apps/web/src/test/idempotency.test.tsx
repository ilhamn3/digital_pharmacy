import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaymentDialog } from '../components/PaymentDialog.js';
import { PosProvider, usePos } from '../context/PosContext.js';
import * as AuthModule from '../context/AuthContext.js';
import { api, ApiError } from '../utils/api.js';

const CartInitializer: React.FC<{ onReady?: (key: string) => void }> = ({ onReady }) => {
  const { addItem, getOrCreateIdempotencyKey } = usePos();

  React.useEffect(() => {
    (async () => {
      await addItem(
        {
          id: 'prod-idem-1',
          name: 'Test Medicine',
          category: 'General',
          unit: 'pack',
          packSize: 1,
          isRxRequired: false,
          reorderLevel: 10,
          isActive: true,
          totalStock: 50,
          expiredQuantity: 0,
          activeBatchCount: 1,
          minMrp: 250,
          maxMrp: 250
        },
        1
      );

      const k = getOrCreateIdempotencyKey();
      if (onReady) onReady(k);
    })();
  }, []);

  return null;
};

describe('POS Idempotency Key Consistency & Retry Invariants', () => {
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
  });

  it('generates consistent idempotency key and reuses the exact same key on retry after network/server error', async () => {
    const recordedPayloads: any[] = [];
    let isReady = false;

    // Mock api.get to return product details when adding item, and receipt after sale
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/products/')) {
        return {
          product: {
            id: 'prod-idem-1',
            name: 'Test Medicine',
            minMrp: 250,
            allowFractionalQty: false,
            batches: []
          }
        };
      }
      return {
        saleId: 'sale-success-123',
        billNo: 'INV-20261114-0001',
        createdAt: new Date().toISOString(),
        cashierName: 'Cashier User',
        subtotal: 250,
        totalAmount: 250,
        paidAmount: 250,
        tenderedAmount: 250,
        changeAmount: 0,
        balanceDue: 0,
        items: [],
        payments: []
      };
    });

    // Mock api.post to fail once with 500/network error, then succeed
    vi.spyOn(api, 'post').mockImplementation(async (url: string, payload?: any) => {
      if (url === '/sales') {
        recordedPayloads.push(payload);
        if (recordedPayloads.length === 1) {
          throw new ApiError(500, 'Database transaction temporary deadlock', 'DEADLOCK_ERROR');
        }
        return { sale: { id: 'sale-success-123' } };
      }
      return {};
    });

    const onSuccess = vi.fn();
    const onClose = vi.fn();

    render(
      <PosProvider>
        <CartInitializer onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />
      </PosProvider>
    );

    // Wait until cart initialization finishes
    await waitFor(() => expect(isReady).toBe(true));

    // Initial pay button click
    const payBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(payBtn);

    // Wait for the error banner to appear and button text to change to Retry Checkout
    await waitFor(() => {
      expect(screen.getByText(/Database transaction temporary deadlock/i)).toBeInTheDocument();
    });

    // Check that first payload contained a valid UUID
    expect(recordedPayloads.length).toBe(1);
    const firstKey = recordedPayloads[0].idempotencyKey;
    expect(firstKey).toBeDefined();
    expect(firstKey.length).toBeGreaterThan(20);

    // The button text should now offer retry
    const retryBtn = await screen.findByRole('button', { name: /Retry Checkout/i });
    expect(retryBtn).toBeInTheDocument();

    // Click retry
    fireEvent.click(retryBtn);

    // Wait for success
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    // Second payload MUST have used the exact same idempotency key!
    expect(recordedPayloads.length).toBe(2);
    const secondKey = recordedPayloads[1].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });

  it('persists idempotencyKey in sessionStorage and reuses it on page reload', async () => {
    let isReady = false;

    render(
      <PosProvider>
        <CartInitializer onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
      </PosProvider>
    );

    await waitFor(() => expect(isReady).toBe(true));

    // Check sessionStorage
    const stored = JSON.parse(sessionStorage.getItem('lanka_pharmacy_pos_cart_v1') || '{}');
    expect(stored.idempotencyKey).toBeDefined();
    expect(typeof stored.idempotencyKey).toBe('string');
    expect(stored.idempotencyKey.length).toBeGreaterThan(20);
  });

  it('handles 409 IDEMPOTENCY_CONFLICT with clear message and requires cashier to review cart before generating new key', async () => {
    let isReady = false;

    vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/sales') {
        throw new ApiError(409, 'Idempotency key has already been used with a different request payload.', 'IDEMPOTENCY_CONFLICT');
      }
      return {};
    });

    const onClose = vi.fn();

    render(
      <PosProvider>
        <CartInitializer onReady={() => { isReady = true; }} />
        <PaymentDialog isOpen={true} onClose={onClose} onSuccess={vi.fn()} />
      </PosProvider>
    );

    await waitFor(() => expect(isReady).toBe(true));

    const payBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(payBtn);

    // Verify 409 Conflict message is displayed
    await waitFor(() => {
      expect(screen.getByText(/Transaction conflict: This idempotency key was previously submitted/i)).toBeInTheDocument();
    });

    // Verify the "Review Cart & Generate New Key" action is displayed
    const reviewBtn = await screen.findByRole('button', { name: /Review Cart & Generate New Key/i });
    expect(reviewBtn).toBeInTheDocument();

    // Click to review and generate new key
    fireEvent.click(reviewBtn);

    // Should close dialog to allow cashier to inspect cart items
    expect(onClose).toHaveBeenCalled();
  });
});
