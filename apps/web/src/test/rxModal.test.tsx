import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RxModal } from '../components/RxModal.js';
import { PosProvider } from '../context/PosContext.js';
import * as AuthModule from '../context/AuthContext.js';

const renderRxModal = (role: 'cashier' | 'pharmacist' | 'owner', onConfirm = vi.fn(), onClose = vi.fn()) => {
  vi.spyOn(AuthModule, 'useAuth').mockReturnValue({
    user: { id: 'test-user', username: 'testuser', fullName: 'Test User', role, isActive: true },
    token: 'mock-token',
    isAuthenticated: true,
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuth: vi.fn()
  });

  return render(
    <PosProvider>
      <RxModal isOpen={true} onClose={onClose} onConfirm={onConfirm} />
    </PosProvider>
  );
};

describe('POS Prescription (Rx) Security Verification Modal', () => {
  it('blocks cashier role with Pharmacist Required warning and disables confirmation', () => {
    const onConfirm = vi.fn();
    renderRxModal('cashier', onConfirm);

    // Alert banner must be visible
    expect(screen.getByText(/Pharmacist or Owner Required/i)).toBeInTheDocument();
    expect(screen.getByText(/RX_DISPENSING_RESTRICTED/i)).toBeInTheDocument();

    // Inputs must be disabled
    const docInput = screen.getByPlaceholderText(/Dr\. K\. Fernando/i);
    const patInput = screen.getByPlaceholderText(/Nimal Perera/i);
    expect(docInput).toBeDisabled();
    expect(patInput).toBeDisabled();

    // Confirm button must be disabled
    const submitBtn = screen.getByRole('button', { name: /Confirm Rx Details/i });
    expect(submitBtn).toBeDisabled();
  });

  it('allows pharmacist to enter doctor and patient names and confirm', () => {
    const onConfirm = vi.fn();
    renderRxModal('pharmacist', onConfirm);

    // Banner should NOT state Pharmacist Required
    expect(screen.queryByText(/Pharmacist or Owner Required/i)).not.toBeInTheDocument();

    const docInput = screen.getByPlaceholderText(/Dr\. K\. Fernando/i);
    const patInput = screen.getByPlaceholderText(/Nimal Perera/i);
    const submitBtn = screen.getByRole('button', { name: /Confirm Rx Details/i });

    expect(docInput).toBeEnabled();
    expect(patInput).toBeEnabled();
    expect(submitBtn).toBeEnabled();

    // Fill in doctor and patient details
    fireEvent.change(docInput, { target: { value: 'Dr. Arthur Silva' } });
    fireEvent.change(patInput, { target: { value: 'Sunil Dias' } });

    fireEvent.click(submitBtn);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('Dr. Arthur Silva', 'Sunil Dias');
  });

  it('displays validation error if doctor or patient name is blank', () => {
    const onConfirm = vi.fn();
    renderRxModal('pharmacist', onConfirm);

    const docInput = screen.getByPlaceholderText(/Dr\. K\. Fernando/i);
    const patInput = screen.getByPlaceholderText(/Nimal Perera/i);
    const submitBtn = screen.getByRole('button', { name: /Confirm Rx Details/i });

    // Leave patient blank
    fireEvent.change(docInput, { target: { value: 'Dr. Fernando' } });
    fireEvent.change(patInput, { target: { value: '   ' } });

    fireEvent.click(submitBtn);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText(/Both Doctor Name and Patient Name are mandatory/i)).toBeInTheDocument();
  });
});
