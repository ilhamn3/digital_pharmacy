import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LoginView } from '../components/LoginView.js';
import { PaymentDialog } from '../components/PaymentDialog.js';
import { AuthProvider } from '../context/AuthContext.js';
import { PosProvider, usePos } from '../context/PosContext.js';
import { api } from '../utils/api.js';

const DummyCartWithCustomer: React.FC<{ onReady: () => void }> = ({ onReady }) => {
  const { addItem, setCustomer } = usePos();

  React.useEffect(() => {
    (async () => {
      setCustomer({
        id: 'cust-sensitive-1',
        name: 'Sensitive Customer',
        phone: '0779998888', // SENSITIVE PHONE NUMBER
        creditLimit: 20000,
        creditBalance: 1000,
        isActive: true
      });

      await addItem(
        {
          id: 'prod-s1',
          name: 'Storage Audit Product',
          category: 'General',
          unit: 'box',
          packSize: 1,
          isRxRequired: false,
          reorderLevel: 5,
          isActive: true,
          totalStock: 50,
          expiredQuantity: 0,
          activeBatchCount: 1,
          minMrp: 300,
          maxMrp: 300
        },
        1
      );

      onReady();
    })();
  }, []);

  return null;
};

describe('Token and Storage Security Audit', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps access token strictly in memory and verifies localStorage is completely empty and sessionStorage contains no tokens or customer phone numbers', async () => {
    const mockAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sensitive_access_token_value_in_memory_only';

    vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/auth/login') {
        return {
          message: 'Login successful',
          accessToken: mockAccessToken,
          user: {
            id: 'u-audit-1',
            username: 'cashier',
            fullName: 'Audit Cashier',
            role: 'cashier',
            isActive: true,
            mustChangePassword: false
          }
        };
      }
      if (url === '/sales') {
        return {
          sale: {
            id: 'sale-audit-1',
            totalAmount: 300,
            paidAmount: 300,
            balanceDue: 0
          }
        };
      }
      return {};
    });

    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/products/')) {
        return {
          product: {
            id: 'prod-s1',
            name: 'Storage Audit Product',
            minMrp: 300,
            allowFractionalQty: false,
            batches: []
          }
        };
      }
      return {
        saleId: 'sale-audit-1',
        billNo: 'INV-AUDIT-001',
        items: [],
        payments: []
      };
    });

    // 1. Render login screen and authenticate
    render(
      <AuthProvider>
        <LoginView />
      </AuthProvider>
    );

    const userField = screen.getByPlaceholderText(/cashier or pharmacist/i);
    const passField = screen.getByPlaceholderText(/••••••••/i);
    const signInBtn = screen.getByRole('button', { name: /^Sign In$/i });

    fireEvent.change(userField, { target: { value: 'cashier' } });
    fireEvent.change(passField, { target: { value: 'password123' } });
    fireEvent.click(signInBtn);

    await waitFor(() => {
      // 2. CRITICAL AUDIT ASSERTION: localStorage MUST BE COMPLETELY EMPTY!
      expect(localStorage.length).toBe(0);
    });

    // 3. Render Cart with Customer and complete checkout
    let cartReady = false;
    const { unmount } = render(
      <AuthProvider>
        <PosProvider>
          <DummyCartWithCustomer onReady={() => { cartReady = true; }} />
          <PaymentDialog isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />
        </PosProvider>
      </AuthProvider>
    );

    await waitFor(() => expect(cartReady).toBe(true));

    // Inspect sessionStorage before checkout
    const sessionDumpBefore = JSON.stringify(sessionStorage);

    // CRITICAL AUDIT ASSERTIONS:
    // A. localStorage must remain completely empty (length = 0)
    expect(localStorage.length).toBe(0);

    // B. sessionStorage must NOT contain any token string
    expect(sessionDumpBefore).not.toContain(mockAccessToken);
    expect(sessionDumpBefore).not.toMatch(/eyJ/i); // Common JWT prefix
    expect(sessionDumpBefore).not.toContain('Bearer');
    expect(sessionDumpBefore).not.toContain('refreshToken');

    // C. sessionStorage must NOT contain customer phone numbers or credit balances
    expect(sessionDumpBefore).not.toContain('0779998888');
    expect(sessionDumpBefore).not.toContain('20000'); // credit limit

    // Complete checkout
    const payBtn = screen.getByRole('button', { name: /Confirm & Print Receipt/i });
    fireEvent.click(payBtn);

    await waitFor(() => {
      // Cart was cleared from sessionStorage on successful checkout
      const cartRaw = sessionStorage.getItem('lanka_pharmacy_pos_cart_v1');
      if (cartRaw) {
        const parsed = JSON.parse(cartRaw);
        expect(parsed.items).toHaveLength(0);
      }
    });

    // Final security confirmation: localStorage remains 0
    expect(localStorage.length).toBe(0);
    unmount();
  });
});
