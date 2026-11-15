import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CartSummary } from '../components/CartSummary.js';
import { PosProvider, usePos } from '../context/PosContext.js';
import * as AuthModule from '../context/AuthContext.js';
import { api } from '../utils/api.js';

// Test wrapper with custom initial cart items
const TestWrapper: React.FC<{ role: 'cashier' | 'pharmacist' | 'owner'; children: React.ReactNode }> = ({
  role,
  children
}) => {
  vi.spyOn(AuthModule, 'useAuth').mockReturnValue({
    user: { id: 'test-user', username: 'testuser', fullName: 'Test User', role, isActive: true },
    token: 'mock-token',
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuth: vi.fn()
  });

  return (
    <PosProvider>
      {children}
    </PosProvider>
  );
};

const CartPopulator: React.FC<{ product: any; onReady?: () => void }> = ({ product, onReady }) => {
  const { addItem } = usePos();

  React.useEffect(() => {
    (async () => {
      await addItem(product, 1);
      if (onReady) onReady();
    })();
  }, []);

  return null;
};

describe('POS Billing Discount Limit Enforcement UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue({
      product: {
        id: 'p1',
        name: 'Painkiller 500mg',
        minMrp: 100,
        allowFractionalQty: false,
        batches: []
      }
    });
  });

  it('disables checkout and displays warning when cashier discount exceeds 5%', async () => {
    const dummyProduct = {
      id: 'p1',
      name: 'Painkiller 500mg',
      category: 'Analgesics',
      unit: 'tablet',
      packSize: 1,
      isRxRequired: false,
      reorderLevel: 10,
      isActive: true,
      totalStock: 100,
      expiredQuantity: 0,
      activeBatchCount: 1,
      minMrp: 100,
      maxMrp: 100
    };

    render(
      <TestWrapper role="cashier">
        <CartPopulator product={dummyProduct} />
        <CartSummary
          onOpenCustomerDialog={vi.fn()}
          onOpenHoldDialog={vi.fn()}
          onOpenPaymentDialog={vi.fn()}
          onConfirmClearCart={vi.fn()}
        />
      </TestWrapper>
    );

    // Wait for item to populate cart and enable checkout
    const payBtn = await screen.findByRole('button', { name: /Pay \/ Checkout/i });
    await waitFor(() => expect(payBtn).toBeEnabled());

    // Set bill discount to Rs. 10 (10% of Rs. 100) -> exceeds 5% limit for cashier
    const discountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(discountInput, { target: { value: '10' } });

    // Warning message should be visible
    await waitFor(() => {
      expect(screen.getByText(/exceeds your role limit \(5%\)/i)).toBeInTheDocument();
    });

    // Checkout button should now be disabled
    expect(payBtn).toBeDisabled();
  });

  it('allows pharmacist to apply discounts up to 15% and blocks above 15%', async () => {
    const dummyProduct = {
      id: 'p2',
      name: 'Antibiotic 250mg',
      category: 'Antibiotics',
      unit: 'capsule',
      packSize: 1,
      isRxRequired: false,
      reorderLevel: 10,
      isActive: true,
      totalStock: 50,
      expiredQuantity: 0,
      activeBatchCount: 1,
      minMrp: 200,
      maxMrp: 200
    };

    render(
      <TestWrapper role="pharmacist">
        <CartPopulator product={dummyProduct} />
        <CartSummary
          onOpenCustomerDialog={vi.fn()}
          onOpenHoldDialog={vi.fn()}
          onOpenPaymentDialog={vi.fn()}
          onConfirmClearCart={vi.fn()}
        />
      </TestWrapper>
    );

    const payBtn = await screen.findByRole('button', { name: /Pay \/ Checkout/i });
    await waitFor(() => expect(payBtn).toBeEnabled());

    // Set Rs. 20 discount on Rs. 200 (10% discount) -> Pharmacist allowed (<= 15%)
    const discountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(discountInput, { target: { value: '20' } });

    expect(screen.queryByText(/exceeds your role limit/i)).not.toBeInTheDocument();
    expect(payBtn).toBeEnabled();

    // Set Rs. 40 discount on Rs. 200 (20% discount) -> Exceeds pharmacist 15% limit
    fireEvent.change(discountInput, { target: { value: '40' } });

    await waitFor(() => {
      expect(screen.getByText(/exceeds your role limit \(15%\)/i)).toBeInTheDocument();
    });
    expect(payBtn).toBeDisabled();
  });

  it('allows owner to apply discounts up to 100%', async () => {
    const dummyProduct = {
      id: 'p3',
      name: 'Vitamins Syrup',
      category: 'Supplements',
      unit: 'bottle',
      packSize: 1,
      isRxRequired: false,
      reorderLevel: 10,
      isActive: true,
      totalStock: 20,
      expiredQuantity: 0,
      activeBatchCount: 1,
      minMrp: 500,
      maxMrp: 500
    };

    render(
      <TestWrapper role="owner">
        <CartPopulator product={dummyProduct} />
        <CartSummary
          onOpenCustomerDialog={vi.fn()}
          onOpenHoldDialog={vi.fn()}
          onOpenPaymentDialog={vi.fn()}
          onConfirmClearCart={vi.fn()}
        />
      </TestWrapper>
    );

    const payBtn = await screen.findByRole('button', { name: /Pay \/ Checkout/i });
    await waitFor(() => expect(payBtn).toBeEnabled());

    // Set Rs. 250 discount on Rs. 500 (50% discount) -> Owner allowed
    const discountInput = screen.getByPlaceholderText('0.00');
    fireEvent.change(discountInput, { target: { value: '250' } });

    expect(screen.queryByText(/exceeds your role limit/i)).not.toBeInTheDocument();
    expect(payBtn).toBeEnabled();
  });
});
