import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PosBillingView } from '../components/PosBillingView.js';
import { CartSummary } from '../components/CartSummary.js';
import { OfflineBanner } from '../components/OfflineBanner.js';
import { LoginView } from '../components/LoginView.js';
import { PosProvider, usePos } from '../context/PosContext.js';
import { AuthProvider } from '../context/AuthContext.js';
import * as AuthModule from '../context/AuthContext.js';
import { api } from '../utils/api.js';

describe('POS Resilience & Offline / Session Invariant Flows', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('displays price update warning banner when resuming a held bill whose price has changed', async () => {
    vi.spyOn(AuthModule, 'useAuth').mockReturnValue({
      user: { id: 'u1', username: 'cashier', fullName: 'Cashier User', role: 'cashier', isActive: true },
      token: 'mock-token',
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      checkAuth: vi.fn()
    });

    const ResumeTrigger: React.FC = () => {
      const { loadHeldBillIntoCart } = usePos();
      return (
        <button
          data-testid="resume-bill-trigger"
          onClick={() => {
            loadHeldBillIntoCart({
              id: 'hold-123',
              holdNo: 'HOLD-001',
              status: 'resumed',
              itemCount: 1,
              estimatedTotal: 350,
              createdAt: new Date().toISOString(),
              items: [
                {
                  id: 'item-1',
                  productId: 'prod-repriced-1',
                  productName: 'Amoxicillin 500mg',
                  unit: 'capsule',
                  quantity: 10,
                  heldPrice: 20, // Held at 20
                  currentMrp: 35, // Current price increased to 35
                  availableStock: 100,
                  isStockAvailable: true,
                  priceChanged: true // Flagged as price changed!
                }
              ]
            });
          }}
        >
          Resume Bill
        </button>
      );
    };

    render(
      <PosProvider>
        <ResumeTrigger />
        <PosBillingView isShortcutsOpen={false} setIsShortcutsOpen={vi.fn()} />
      </PosProvider>
    );

    // Click resume
    fireEvent.click(screen.getByTestId('resume-bill-trigger'));

    // Assert that the Price Update Warning banner appears prominently
    await waitFor(() => {
      expect(
        screen.getByText(/Price update warning: Retail prices have changed.*Amoxicillin 500mg/i)
      ).toBeInTheDocument();
    });
  });

  it('displays offline banner and disables checkout button while offline, then restores upon reconnection', async () => {
    vi.spyOn(AuthModule, 'useAuth').mockReturnValue({
      user: { id: 'u1', username: 'cashier', fullName: 'Cashier User', role: 'cashier', isActive: true },
      token: 'mock-token',
      isAuthenticated: true,
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
      checkAuth: vi.fn()
    });

    const CartPopulator: React.FC = () => {
      const { addItem } = usePos();
      React.useEffect(() => {
        addItem({
          id: 'prod-off-1',
          name: 'Offline Test Item',
          category: 'General',
          unit: 'pack',
          packSize: 1,
          isRxRequired: false,
          reorderLevel: 5,
          isActive: true,
          totalStock: 50,
          expiredQuantity: 0,
          activeBatchCount: 1,
          minMrp: 150,
          maxMrp: 150
        });
      }, []);
      return null;
    };

    vi.spyOn(api, 'get').mockResolvedValue({
      product: {
        id: 'prod-off-1',
        name: 'Offline Test Item',
        minMrp: 150,
        allowFractionalQty: false,
        batches: []
      }
    });

    render(
      <PosProvider>
        <OfflineBanner />
        <CartPopulator />
        <CartSummary
          onOpenCustomerDialog={vi.fn()}
          onOpenHoldDialog={vi.fn()}
          onOpenPaymentDialog={vi.fn()}
          onConfirmClearCart={vi.fn()}
        />
      </PosProvider>
    );

    // Initial state: Online -> Pay / Checkout button enabled
    const payBtn = await screen.findByRole('button', { name: /Pay \/ Checkout/i });
    await waitFor(() => expect(payBtn).toBeEnabled());
    expect(screen.queryByText(/Offline Mode/i)).not.toBeInTheDocument();

    // 1. Simulate network drop
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    // Verify Offline banner appears
    await waitFor(() => {
      expect(screen.getByText(/Offline Mode — Network connection lost/i)).toBeInTheDocument();
    });

    // Verify Checkout button is disabled and shows offline text
    expect(screen.getByRole('button', { name: /Offline — Reconnect to Pay/i })).toBeDisabled();

    // 2. Simulate network restored
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    // Banner disappears and Checkout button is re-enabled
    await waitFor(() => {
      expect(screen.queryByText(/Offline Mode — Network connection lost/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Pay \/ Checkout/i })).toBeEnabled();
  });

  it('keeps active cart in sessionStorage across access token expiry and refresh failure', async () => {
    // 1. Store cart in sessionStorage
    sessionStorage.setItem(
      'lanka_pharmacy_pos_cart_v1',
      JSON.stringify({
        items: [
          {
            productId: 'prod-persist-1',
            productName: 'Preserved Medicine',
            quantity: 3,
            unitPrice: '100.00',
            discountType: 'percent',
            discountValue: 0,
            discountAmount: '0.00',
            lineTotal: '300.00'
          }
        ],
        billDiscount: 0,
        idempotencyKey: 'saved-idempotency-key-1234'
      })
    );

    // 2. Mock refresh failure (session completely expired)
    vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/auth/refresh') {
        throw new Error('Refresh token expired');
      }
      return {};
    });

    // 3. Render LoginView (user logged out due to expired session)
    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>
    );

    // Verify login view is shown
    expect(screen.getByText(/Lanka Health Pharmacy/i)).toBeInTheDocument();

    // 4. CRITICAL ASSERTION: The cart in sessionStorage was NOT lost!
    const saved = JSON.parse(sessionStorage.getItem('lanka_pharmacy_pos_cart_v1') || '{}');
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].productName).toBe('Preserved Medicine');
    expect(saved.idempotencyKey).toBe('saved-idempotency-key-1234');
  });
});
