import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../utils/api.js';
import { formatMoney } from '../utils/cartMath.js';
import { SaleSummary, ReceiptData } from '../types/pos.js';
import { ReceiptModal } from './ReceiptModal.js';
import {
  Printer,
  Ban,
  AlertCircle,
  Loader2
} from 'lucide-react';

export const SalesHistoryView: React.FC = () => {
  const { user } = useAuth();
  const isCashier = user?.role === 'cashier';
  const canVoid = user?.role === 'owner' || user?.role === 'pharmacist';

  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const todayStr = new Date().toISOString().split('T')[0];
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);

  // Receipt Modal State
  const [activeReceipt, setActiveReceipt] = useState<ReceiptData | null>(null);
  const [isReceiptOpen, setIsReceiptOpen] = useState<boolean>(false);

  // Void Modal State
  const [voidSaleTarget, setVoidSaleTarget] = useState<SaleSummary | null>(null);
  const [voidReason, setVoidReason] = useState<string>('');
  const [isVoiding, setIsVoiding] = useState<boolean>(false);
  const [voidError, setVoidError] = useState<string | null>(null);

  const loadSales = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const q = isCashier ? '' : `?date=${selectedDate}`;
      const res = await api.get<{ sales: SaleSummary[] }>(`/sales${q}`);
      setSales(res.sales || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch sales history');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSales();
  }, [selectedDate]);

  const handleOpenReceipt = async (saleId: string) => {
    try {
      const receipt = await api.get<ReceiptData>(`/sales/${saleId}/receipt`);
      setActiveReceipt(receipt);
      setIsReceiptOpen(true);
    } catch (err: any) {
      alert(err.message || 'Failed to load receipt');
    }
  };

  const handleConfirmVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidSaleTarget) return;
    if (!voidReason.trim()) {
      setVoidError('A reason is mandatory when voiding a sale.');
      return;
    }

    setIsVoiding(true);
    setVoidError(null);

    try {
      await api.post(`/sales/${voidSaleTarget.id}/void`, {
        reason: voidReason.trim()
      });

      setVoidSaleTarget(null);
      setVoidReason('');
      await loadSales();
    } catch (err: any) {
      setVoidError(err.message || 'Failed to void sale');
    } finally {
      setIsVoiding(false);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto p-4 space-y-4">
      {/* Header & Filter Bar */}
      <div className="bg-white rounded-lg border border-slate-200 p-4 shadow-sm flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-800">Sales Transactions</h2>
          <p className="text-xs text-slate-500">
            {isCashier
              ? "Viewing today's bills created by your account."
              : 'Audit log of completed and voided sales.'}
          </p>
        </div>

        {/* Date Filter (Owner / Pharmacist only) */}
        {!isCashier && (
          <div className="flex items-center space-x-2 text-xs">
            <span className="font-semibold text-slate-600">Select Date:</span>
            <div className="relative">
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-mono font-medium focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <button
              onClick={loadSales}
              className="px-3 py-1.5 bg-slate-800 text-white rounded-lg font-medium hover:bg-slate-700 transition-colors"
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Sales Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200">
                <th className="py-2.5 px-3">Bill Number</th>
                <th className="py-2.5 px-3">Time</th>
                <th className="py-2.5 px-3">Customer</th>
                <th className="py-2.5 px-3">Cashier</th>
                <th className="py-2.5 px-3 text-center">Items</th>
                <th className="py-2.5 px-3 text-right">Total Amount</th>
                <th className="py-2.5 px-3 text-center">Payment</th>
                <th className="py-2.5 px-3 text-center">Status</th>
                <th className="py-2.5 px-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {isLoading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    <div className="flex items-center justify-center space-x-2">
                      <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                      <span>Loading transactions...</span>
                    </div>
                  </td>
                </tr>
              ) : sales.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-slate-400">
                    No sales recorded for this period.
                  </td>
                </tr>
              ) : (
                sales.map((sale) => {
                  const isVoided = sale.status === 'voided';

                  return (
                    <tr
                      key={sale.id}
                      className={`hover:bg-slate-50 transition-colors ${
                        isVoided ? 'bg-red-50/30 opacity-75' : ''
                      }`}
                    >
                      {/* Bill No */}
                      <td className="py-2.5 px-3 font-mono font-bold text-slate-900">
                        {sale.billNo}
                      </td>

                      {/* Time */}
                      <td className="py-2.5 px-3 text-slate-500 font-mono text-[11px]">
                        {new Date(sale.createdAt).toLocaleTimeString()}
                      </td>

                      {/* Customer */}
                      <td className="py-2.5 px-3 text-slate-700">
                        {sale.customerName || (
                          <span className="text-slate-400 italic">Walk-in</span>
                        )}
                      </td>

                      {/* Cashier */}
                      <td className="py-2.5 px-3 text-slate-600">{sale.cashierName}</td>

                      {/* Items */}
                      <td className="py-2.5 px-3 text-center text-slate-600 font-mono">
                        {sale.itemCount}
                      </td>

                      {/* Total */}
                      <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900">
                        {formatMoney(sale.totalAmount)}
                      </td>

                      {/* Payment Status */}
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            sale.paymentStatus === 'paid'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {sale.paymentStatus}
                        </span>
                      </td>

                      {/* Status */}
                      <td className="py-2.5 px-3 text-center">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            isVoided
                              ? 'bg-red-100 text-red-800 border border-red-200'
                              : 'bg-emerald-100 text-emerald-800'
                          }`}
                        >
                          {sale.status}
                        </span>
                        {isVoided && sale.voidReason && (
                          <div className="text-[9px] text-red-600 italic mt-0.5">
                            "{sale.voidReason}"
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-2.5 px-3 text-right space-x-1.5">
                        <button
                          type="button"
                          onClick={() => handleOpenReceipt(sale.id)}
                          title="View & Reprint Thermal Receipt"
                          className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded border border-slate-300 font-medium inline-flex items-center space-x-1"
                        >
                          <Printer className="w-3 h-3 text-slate-600" />
                          <span>Receipt</span>
                        </button>

                        {/* Void button - Owner & Pharmacist ONLY, on active sales */}
                        {canVoid && !isVoided && (
                          <button
                            type="button"
                            onClick={() => {
                              setVoidSaleTarget(sale);
                              setVoidReason('');
                              setVoidError(null);
                            }}
                            title="Void Sale (Reverses stock and credit balance)"
                            className="px-2 py-1 text-[11px] bg-red-50 hover:bg-red-100 text-red-700 rounded border border-red-200 font-semibold inline-flex items-center space-x-1"
                          >
                            <Ban className="w-3 h-3 text-red-600" />
                            <span>Void</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Thermal Receipt Modal */}
      <ReceiptModal
        receipt={activeReceipt}
        isOpen={isReceiptOpen}
        onClose={() => setIsReceiptOpen(false)}
      />

      {/* Void Confirmation Modal */}
      {voidSaleTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
        >
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
            <div className="px-5 py-4 bg-red-700 text-white flex items-center justify-between">
              <div className="flex items-center space-x-2 font-bold text-sm">
                <Ban className="w-5 h-5 text-white" />
                <span>Void Sale Confirmation</span>
              </div>
              <button
                onClick={() => setVoidSaleTarget(null)}
                className="text-red-200 hover:text-white"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleConfirmVoid} className="p-5 space-y-4 text-xs">
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-800">
                <p className="font-bold mb-1">
                  Are you sure you want to void Bill #{voidSaleTarget.billNo}?
                </p>
                <p className="text-[11px]">
                  This action restores all deducted quantities back into their original batches,
                  reverses any customer credit balance, and writes a void entry in audit logs.
                </p>
              </div>

              {voidError && (
                <div className="p-2.5 bg-red-100 border border-red-300 text-red-800 rounded font-semibold">
                  {voidError}
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Reason for Void * (Mandatory)
                </label>
                <textarea
                  required
                  rows={3}
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                  placeholder="e.g. Customer returned items immediately before exit / Billing error"
                  className="w-full p-2 border border-slate-300 rounded-lg focus:border-red-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setVoidSaleTarget(null)}
                  disabled={isVoiding}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-100 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isVoiding}
                  className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg flex items-center space-x-1.5 transition-colors"
                >
                  {isVoiding ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Ban className="w-3.5 h-3.5" />
                  )}
                  <span>Confirm Void Sale</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
