import React, { useState, useEffect, useMemo, useRef } from 'react';
import { usePos } from '../context/PosContext.js';
import { formatMoney, calculateCashChange } from '../utils/cartMath.js';
import { api } from '../utils/api.js';
import { ReceiptData, PaymentEntry } from '../types/pos.js';
import Decimal from 'decimal.js';
import {
  CreditCard,
  Banknote,
  Building,
  Clock,
  X,
  AlertCircle,
  Loader2,
  CheckCircle,
  RefreshCw
} from 'lucide-react';

interface PaymentDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (receipt: ReceiptData) => void;
}

export const PaymentDialog: React.FC<PaymentDialogProps> = ({ isOpen, onClose, onSuccess }) => {
  const { items, customer, billDiscount, totals, doctorName, patientName, notes, getOrCreateIdempotencyKey, resetIdempotencyKey, clearCart } = usePos();

  const grandTotalDec = useMemo(() => new Decimal(totals.grandTotal || 0), [totals.grandTotal]);
  const grandTotalNum = grandTotalDec.toNumber();

  // Mode: single payment or split payment
  const [paymentMode, setPaymentMode] = useState<'single' | 'split'>('single');

  // Single payment state
  const [singleMethod, setSingleMethod] = useState<'cash' | 'card' | 'bank_transfer' | 'credit'>('cash');
  const [tenderedAmount, setTenderedAmount] = useState<number>(grandTotalNum);
  const [cardRef, setCardRef] = useState<string>('');

  // Split payments state
  const [splitPayments, setSplitPayments] = useState<PaymentEntry[]>([
    { type: 'cash', amount: grandTotalNum }
  ]);
  const [splitTendered, setSplitTendered] = useState<number>(grandTotalNum);

  // Submission & Retry states
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [isRetryable, setIsRetryable] = useState<boolean>(false);
  const [isConflict, setIsConflict] = useState<boolean>(false);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setPaymentMode('single');
      setSingleMethod('cash');
      setServerError(null);
      setIsRetryable(false);
      setIsConflict(false);
      setTenderedAmount(grandTotalNum);
      setSplitPayments([{ type: 'cash', amount: grandTotalNum }]);
      setSplitTendered(grandTotalNum);
      getOrCreateIdempotencyKey();
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, grandTotalNum, getOrCreateIdempotencyKey]);

  // Change computation
  const cashChangePreview = useMemo(() => {
    if (paymentMode === 'single') {
      if (singleMethod === 'cash') {
        return calculateCashChange(tenderedAmount, grandTotalNum);
      }
      return '0.00';
    } else {
      const cashEntry = splitPayments.find((p) => p.type === 'cash');
      const cashApplied = cashEntry ? cashEntry.amount : 0;
      return calculateCashChange(splitTendered, cashApplied);
    }
  }, [paymentMode, singleMethod, tenderedAmount, grandTotalNum, splitPayments, splitTendered]);

  // Total applied across payments (excluding store credit which is never a payment tender)
  const totalApplied = useMemo(() => {
    if (paymentMode === 'single') {
      return singleMethod === 'credit' ? 0 : grandTotalNum;
    }
    return splitPayments
      .filter((p) => p.type !== 'credit')
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  }, [paymentMode, singleMethod, grandTotalNum, splitPayments]);

  const balanceDue = Math.max(0, grandTotalNum - totalApplied);

  if (!isOpen) return null;

  const handleSubmitCheckout = async () => {
    // Check credit rules: if balance due > 0 or credit method used, customer is mandatory
    const isCredit = balanceDue > 0 || (paymentMode === 'single' ? singleMethod === 'credit' : splitPayments.some((p) => p.type === 'credit'));
    if (isCredit && !customer) {
      setServerError('A registered customer is required for credit / partial balance sales.');
      return;
    }

    // Reuse the exact same idempotencyKey across retries!
    const key = getOrCreateIdempotencyKey();

    setIsSubmitting(true);
    setServerError(null);
    setIsConflict(false);

    // Build payment array - credit must NEVER be sent as a payments row!
    let finalPayments: any[] = [];
    let finalTendered = 0;

    if (paymentMode === 'single') {
      if (singleMethod === 'cash') {
        finalPayments = [{ type: 'cash', amount: grandTotalNum }];
        finalTendered = Number(tenderedAmount || grandTotalNum);
      } else if (singleMethod === 'card') {
        finalPayments = [{ type: 'card', amount: grandTotalNum, referenceNo: cardRef.trim() || undefined }];
        finalTendered = grandTotalNum;
      } else if (singleMethod === 'bank_transfer') {
        finalPayments = [{ type: 'bank_transfer', amount: grandTotalNum, referenceNo: cardRef.trim() || undefined }];
        finalTendered = grandTotalNum;
      } else if (singleMethod === 'credit') {
        // Credit sale: 0 payment rows sent; server derives balance_due and customer ledger entry
        finalPayments = [];
        finalTendered = 0;
      }
    } else {
      // Split payments: ONLY send real tenders (cash, card, bank_transfer). Filter out credit!
      finalPayments = splitPayments
        .filter((p) => p.type !== 'credit' && Number(p.amount) > 0)
        .map((p) => ({
          type: p.type,
          amount: Number(p.amount),
          referenceNo: p.referenceNo?.trim() || undefined
        }));
      const cashEntry = splitPayments.find((p) => p.type === 'cash');
      const totalReal = finalPayments.reduce((s, p) => s + p.amount, 0);
      finalTendered = cashEntry ? Number(splitTendered || cashEntry.amount || 0) : totalReal;
    }

    const payload = {
      idempotencyKey: key,
      customerId: customer?.id || null,
      items: items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
        discountAmount: Number(i.discountAmount || 0)
      })),
      billDiscount: Number(billDiscount || 0),
      payments: finalPayments,
      tenderedAmount: finalTendered,
      doctorName: doctorName.trim() || null,
      patientName: patientName.trim() || null,
      notes: notes.trim() || null
    };

    try {
      const res = await api.post<{ sale: any; receipt?: ReceiptData }>('/sales', payload);

      // Fetch full thermal receipt format
      const saleId = res.sale.id;
      const receiptRes = await api.get<ReceiptData>(`/sales/${saleId}/receipt`);

      clearCart();
      onSuccess(receiptRes);
      onClose();
    } catch (err: any) {
      console.error('Checkout failed:', err);
      if (err.status === 409 || err.code === 'IDEMPOTENCY_CONFLICT') {
        setIsRetryable(false);
        setIsConflict(true);
        setServerError('Transaction conflict: This idempotency key was previously submitted with different cart details. Please review your cart before generating a new transaction.');
      } else {
        const isNetOr5xx = err.status === 0 || err.status >= 500;
        setIsRetryable(isNetOr5xx);
        setServerError(err.message || 'Payment processing failed. You may retry safely without double-charging.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div>
            <h2 className="font-bold text-sm tracking-wide">Finalize Sale & Payment</h2>
            <p className="text-[11px] text-slate-400">Total Bill: {formatMoney(totals.grandTotal)}</p>
          </div>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-400 hover:text-white p-1 rounded transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Server Error / Retry Banner */}
        {serverError && (
          <div className="m-4 mb-0 p-3 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-semibold block">{serverError}</span>
              {isRetryable && (
                <span className="text-[11px] text-red-600 block mt-0.5">
                  Idempotency key retained. Click 'Retry Checkout' to resubmit safely without risk of duplicate bills.
                </span>
              )}
            </div>
          </div>
        )}

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Payment Mode Switcher */}
          <div className="flex border border-slate-200 rounded-lg p-0.5 bg-slate-100 text-slate-700 font-semibold">
            <button
              type="button"
              onClick={() => setPaymentMode('single')}
              className={`flex-1 py-1.5 rounded-md text-center transition-colors ${
                paymentMode === 'single' ? 'bg-white shadow-xs text-slate-900' : 'hover:text-slate-900'
              }`}
            >
              Standard Payment
            </button>
            <button
              type="button"
              onClick={() => setPaymentMode('split')}
              className={`flex-1 py-1.5 rounded-md text-center transition-colors ${
                paymentMode === 'split' ? 'bg-white shadow-xs text-slate-900' : 'hover:text-slate-900'
              }`}
            >
              Split / Partial Payment
            </button>
          </div>

          {paymentMode === 'single' ? (
            <div className="space-y-4">
              {/* Method Selection Buttons */}
              <div className="grid grid-cols-4 gap-2">
                <button
                  type="button"
                  onClick={() => setSingleMethod('cash')}
                  className={`p-2.5 rounded-lg border text-center transition-all ${
                    singleMethod === 'cash'
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-900 font-bold ring-1 ring-emerald-500'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <Banknote className="w-5 h-5 mx-auto mb-1 text-emerald-600" />
                  <span>Cash</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSingleMethod('card')}
                  className={`p-2.5 rounded-lg border text-center transition-all ${
                    singleMethod === 'card'
                      ? 'border-blue-500 bg-blue-50 text-blue-900 font-bold ring-1 ring-blue-500'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <CreditCard className="w-5 h-5 mx-auto mb-1 text-blue-600" />
                  <span>Card</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSingleMethod('bank_transfer')}
                  className={`p-2.5 rounded-lg border text-center transition-all ${
                    singleMethod === 'bank_transfer'
                      ? 'border-purple-500 bg-purple-50 text-purple-900 font-bold ring-1 ring-purple-500'
                      : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <Building className="w-5 h-5 mx-auto mb-1 text-purple-600" />
                  <span>Transfer</span>
                </button>

                <button
                  type="button"
                  disabled={!customer}
                  onClick={() => setSingleMethod('credit')}
                  className={`p-2.5 rounded-lg border text-center transition-all ${
                    singleMethod === 'credit'
                      ? 'border-amber-500 bg-amber-50 text-amber-900 font-bold ring-1 ring-amber-500'
                      : customer
                      ? 'border-slate-200 hover:bg-slate-50 text-slate-700'
                      : 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <Clock className="w-5 h-5 mx-auto mb-1 text-amber-600" />
                  <span>Credit</span>
                </button>
              </div>

              {/* Cash Options: Tendered Amount & Change Preview */}
              {singleMethod === 'cash' && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <label className="font-semibold text-slate-700">Cash Tendered (Rs.)</label>
                    <input
                      type="number"
                      step="50"
                      min={grandTotalNum}
                      value={tenderedAmount}
                      onChange={(e) => setTenderedAmount(parseFloat(e.target.value) || 0)}
                      className="w-32 px-3 py-1.5 text-right font-mono font-bold text-slate-900 text-sm border border-slate-300 rounded focus:border-emerald-500 focus:outline-none"
                    />
                  </div>

                  {/* Preset quick buttons */}
                  <div className="flex space-x-1.5">
                    {[
                      { label: 'Exact', val: grandTotalNum },
                      { label: '+100', val: Math.ceil(grandTotalNum / 100) * 100 },
                      { label: '+500', val: Math.ceil(grandTotalNum / 500) * 500 },
                      { label: '+1000', val: Math.ceil(grandTotalNum / 1000) * 1000 },
                      { label: '5,000', val: 5000 }
                    ].map((btn, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setTenderedAmount(Math.max(grandTotalNum, btn.val))}
                        className="flex-1 py-1 text-[11px] font-mono font-medium bg-white hover:bg-slate-200 border border-slate-300 rounded text-slate-700 transition-colors"
                      >
                        {btn.label}
                      </button>
                    ))}
                  </div>

                  {/* Change Preview */}
                  <div className="pt-2 border-t border-slate-200 flex justify-between items-baseline">
                    <span className="font-bold text-slate-700 text-xs">Change to Return:</span>
                    <span className="text-base font-extrabold font-mono text-emerald-700">
                      Rs. {cashChangePreview}
                    </span>
                  </div>
                </div>
              )}

              {/* Card / Bank Reference Field */}
              {(singleMethod === 'card' || singleMethod === 'bank_transfer') && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <label className="block font-semibold text-slate-700 mb-1">
                    Card Terminal Ref / Bank Transfer Ref
                  </label>
                  <input
                    type="text"
                    value={cardRef}
                    onChange={(e) => setCardRef(e.target.value)}
                    placeholder="e.g. TXN-998811 or slip reference"
                    className="w-full px-3 py-1.5 border border-slate-300 rounded focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-400 mt-1">
                    Terminal charged exact bill amount of {formatMoney(totals.grandTotal)}. Over-tendering not permitted.
                  </p>
                </div>
              )}

              {/* Credit Confirmation */}
              {singleMethod === 'credit' && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900">
                  <div className="font-bold mb-1">Full Credit Sale</div>
                  <p className="text-[11px]">
                    Entire bill amount of {formatMoney(totals.grandTotal)} will be charged to{' '}
                    <strong>{customer?.name}</strong>'s credit account.
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Split / Partial Payment */
            <div className="space-y-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
              <span className="font-bold text-slate-700 block">Split Payment Breakdown</span>

              {splitPayments.map((p, idx) => (
                <div key={idx} className="flex gap-2 items-center" data-testid="split-payment-row">
                  <select
                    value={p.type}
                    data-testid={`split-method-${idx}`}
                    onChange={(e) => {
                      const updated = [...splitPayments];
                      updated[idx].type = e.target.value as any;
                      setSplitPayments(updated);
                    }}
                    className="w-32 px-2 py-1.5 border border-slate-300 rounded bg-white"
                  >
                    <option value="cash">Cash</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank Transfer</option>
                    <option value="credit" disabled={!customer}>
                      Store Credit
                    </option>
                  </select>

                  <input
                    type="number"
                    min="0"
                    step="50"
                    value={p.amount}
                    data-testid={`split-amount-${idx}`}
                    onChange={(e) => {
                      const updated = [...splitPayments];
                      updated[idx].amount = parseFloat(e.target.value) || 0;
                      setSplitPayments(updated);
                    }}
                    className="flex-1 px-2 py-1.5 font-mono text-right border border-slate-300 rounded bg-white"
                  />

                  {splitPayments.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSplitPayments(splitPayments.filter((_, i) => i !== idx))}
                      className="text-red-500 hover:text-red-700 px-1 text-sm font-bold"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}

              <button
                type="button"
                onClick={() => setSplitPayments([...splitPayments, { type: 'card', amount: 0 }])}
                className="text-[11px] font-bold text-emerald-700 hover:underline"
              >
                + Add Another Payment Method
              </button>

              <div className="pt-2 border-t border-slate-200 space-y-1">
                <div className="flex justify-between">
                  <span>Total Bill:</span>
                  <span className="font-mono font-bold">{formatMoney(totals.grandTotal)}</span>
                </div>
                <div className="flex justify-between text-emerald-700">
                  <span>Total Payments Applied:</span>
                  <span className="font-mono font-bold">{formatMoney(totalApplied)}</span>
                </div>
                {balanceDue > 0 && (
                  <div className="flex justify-between text-amber-700 font-bold">
                    <span>Remaining Balance (Store Credit):</span>
                    <span className="font-mono">{formatMoney(balanceDue)}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-5 py-4 bg-slate-100 border-t border-slate-200 flex justify-between items-center">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-200 font-medium text-xs disabled:opacity-40"
          >
            Cancel (Esc)
          </button>

          {isConflict ? (
            <button
              type="button"
              onClick={() => {
                resetIdempotencyKey();
                setIsConflict(false);
                setServerError(null);
                onClose();
              }}
              className="px-6 py-2.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg text-xs shadow-sm transition-colors flex items-center space-x-2 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Review Cart & Generate New Key</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmitCheckout}
              disabled={isSubmitting}
              className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white font-bold rounded-lg text-xs shadow-sm transition-colors flex items-center space-x-2 cursor-pointer disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Processing Payment...</span>
                </>
              ) : isRetryable ? (
                <>
                  <RefreshCw className="w-4 h-4" />
                  <span>Retry Checkout</span>
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4" />
                  <span>Confirm & Print Receipt (F9)</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
