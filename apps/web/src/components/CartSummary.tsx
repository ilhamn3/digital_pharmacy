import React, { useState, useEffect } from 'react';
import { usePos } from '../context/PosContext.js';
import { useAuth } from '../context/AuthContext.js';
import { formatMoney, isDiscountAllowed } from '../utils/cartMath.js';
import { User, AlertTriangle, CreditCard, Pause, Trash2 } from 'lucide-react';

interface CartSummaryProps {
  onOpenCustomerDialog: () => void;
  onOpenHoldDialog: () => void;
  onOpenPaymentDialog: () => void;
  onConfirmClearCart: () => void;
}

export const CartSummary: React.FC<CartSummaryProps> = ({
  onOpenCustomerDialog,
  onOpenHoldDialog,
  onOpenPaymentDialog,
  onConfirmClearCart
}) => {
  const { items, customer, billDiscount, setBillDiscount, totals, hasRxItems } = usePos();
  const { user } = useAuth();

  const [isOnline, setIsOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const userRole = user?.role || 'cashier';
  const discountCheck = isDiscountAllowed(userRole, totals.totalDiscountPercent);
  const isOverDiscountLimit = !discountCheck.allowed;

  const hasItems = items.length > 0;

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm p-4 flex flex-col justify-between space-y-4">
      {/* 1. Customer Section */}
      <div className="border-b border-slate-200 pb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center space-x-1">
            <User className="w-3.5 h-3.5 text-slate-500" />
            <span>Customer</span>
          </span>
          <button
            type="button"
            onClick={onOpenCustomerDialog}
            className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 hover:underline flex items-center space-x-1"
          >
            <span>{customer ? 'Change (F4)' : 'Select Customer (F4)'}</span>
          </button>
        </div>

        {customer ? (
          <div className="bg-slate-50 rounded-md p-2 border border-slate-200 text-xs">
            <div className="font-bold text-slate-800">{customer.name}</div>
            <div className="flex justify-between text-slate-500 text-[11px] mt-0.5">
              <span>{customer.phone || 'No phone'}</span>
              <span className="font-medium">
                Balance: <span className="font-bold text-amber-700">{formatMoney(customer.creditBalance)}</span> /{' '}
                Limit: {formatMoney(customer.creditLimit)}
              </span>
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500 italic flex items-center justify-between">
            <span>Walk-in Customer (Cash / Card only)</span>
            <span className="text-[10px] bg-slate-100 text-slate-500 px-1 py-0.2 rounded border border-slate-200">
              F4
            </span>
          </div>
        )}
      </div>

      {/* 2. Running Totals Preview */}
      <div className="space-y-2 text-xs flex-1">
        <div className="flex justify-between text-slate-600">
          <span>Gross Subtotal ({totals.itemCount} items, {totals.totalUnits} units)</span>
          <span className="font-mono font-medium text-slate-800">{formatMoney(totals.grossSubtotal)}</span>
        </div>

        {Number(totals.lineDiscountsSum) > 0 && (
          <div className="flex justify-between text-emerald-700 font-medium">
            <span>Item Discounts</span>
            <span className="font-mono">- {formatMoney(totals.lineDiscountsSum)}</span>
          </div>
        )}

        {/* Bill Discount Input with Role Limit Indicator */}
        <div className="pt-1">
          <div className="flex items-center justify-between mb-1">
            <span className="text-slate-700 font-medium">
              Bill Discount (Max {discountCheck.maxAllowed}% for {userRole}):
            </span>
            <div className="flex items-center space-x-1">
              <span className="text-slate-400 font-mono text-[11px]">Rs.</span>
              <input
                type="number"
                min="0"
                step="10"
                value={billDiscount || ''}
                onChange={(e) => setBillDiscount(parseFloat(e.target.value) || 0)}
                placeholder="0.00"
                className={`w-20 text-right px-1.5 py-0.5 text-xs font-mono border rounded focus:outline-none ${
                  isOverDiscountLimit
                    ? 'border-red-500 bg-red-50 text-red-700'
                    : 'border-slate-300 focus:border-emerald-500'
                }`}
              />
            </div>
          </div>

          {/* Discount Exceeded Warning */}
          {isOverDiscountLimit && (
            <div className="p-1.5 rounded bg-red-50 border border-red-200 text-red-700 text-[10px] flex items-center space-x-1 font-medium mt-1">
              <AlertTriangle className="w-3.5 h-3.5 text-red-600 shrink-0" />
              <span>
                Combined discount ({totals.totalDiscountPercent}%) exceeds your role limit ({discountCheck.maxAllowed}%).
              </span>
            </div>
          )}

          {Number(totals.totalDiscount) > 0 && (
            <div className="flex justify-between text-[11px] text-slate-500 font-mono mt-0.5">
              <span>Total Discount ({totals.totalDiscountPercent}%)</span>
              <span className="text-emerald-700 font-bold">- {formatMoney(totals.totalDiscount)}</span>
            </div>
          )}
        </div>

        {/* Tax (if applicable) */}
        {Number(totals.taxAmount) > 0 && (
          <div className="flex justify-between text-slate-600 pt-1">
            <span>Tax ({totals.taxRate}%)</span>
            <span className="font-mono font-medium">{formatMoney(totals.taxAmount)}</span>
          </div>
        )}

        {/* Grand Total Display */}
        <div className="pt-2 border-t border-slate-200">
          <div className="flex justify-between items-baseline">
            <div>
              <span className="text-sm font-bold text-slate-900 block">Total Amount</span>
              <span className="text-[10px] text-slate-400">Preview (Authoritative on checkout)</span>
            </div>
            <div className="text-xl font-extrabold text-emerald-700 font-mono">
              {formatMoney(totals.grandTotal)}
            </div>
          </div>
        </div>

        {/* Rx Requirement Reminder */}
        {hasRxItems && (
          <div className="p-2 rounded bg-amber-50 border border-amber-200 text-amber-900 text-[11px] flex items-center space-x-1.5">
            <span className="font-bold px-1 rounded bg-amber-200 text-amber-900 text-[10px]">Rx</span>
            <span>Contains prescription items. Doctor & Patient details required.</span>
          </div>
        )}
      </div>

      {/* 3. Action Buttons */}
      <div className="pt-3 border-t border-slate-200 space-y-2">
        {/* Primary Checkout Button */}
        <button
          type="button"
          onClick={onOpenPaymentDialog}
          disabled={!hasItems || isOverDiscountLimit || !isOnline}
          className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white font-bold py-3 px-4 rounded-lg shadow-sm transition-colors flex items-center justify-between text-sm cursor-pointer disabled:cursor-not-allowed"
        >
          <div className="flex items-center space-x-2">
            <CreditCard className="w-5 h-5" />
            <span>{!isOnline ? 'Offline — Reconnect to Pay' : 'Pay / Checkout'}</span>
            <span className="text-[10px] font-mono bg-emerald-800/40 px-1.5 py-0.5 rounded border border-emerald-400/30">
              F9
            </span>
          </div>
          <span className="font-mono text-base">{formatMoney(totals.grandTotal)}</span>
        </button>

        {/* Secondary Buttons: Hold Bill & Clear Cart */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onOpenHoldDialog}
            disabled={!hasItems}
            className="flex items-center justify-center space-x-1.5 py-2 px-3 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 disabled:opacity-50 text-slate-700 text-xs font-semibold transition-colors"
          >
            <Pause className="w-3.5 h-3.5 text-amber-600" />
            <span>Hold Bill (F8)</span>
          </button>

          <button
            type="button"
            onClick={onConfirmClearCart}
            disabled={!hasItems}
            className="flex items-center justify-center space-x-1.5 py-2 px-3 rounded-lg border border-slate-300 bg-slate-50 hover:bg-red-50 hover:text-red-700 hover:border-red-300 disabled:opacity-50 text-slate-700 text-xs font-semibold transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Cart</span>
          </button>
        </div>
      </div>
    </div>
  );
};
