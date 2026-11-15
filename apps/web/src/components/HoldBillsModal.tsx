import React, { useState, useEffect } from 'react';
import { usePos } from '../context/PosContext.js';
import { api } from '../utils/api.js';
import { formatMoney } from '../utils/cartMath.js';
import { HoldBill } from '../types/pos.js';
import { Pause, Play, Trash2, X, AlertTriangle, Loader2 } from 'lucide-react';

interface HoldBillsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HoldBillsModal: React.FC<HoldBillsModalProps> = ({ isOpen, onClose }) => {
  const { items, customer, notes: cartNotes, clearCart, loadHeldBillIntoCart } = usePos();

  const [heldBills, setHeldBills] = useState<HoldBill[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // New Hold Bill form state
  const [customerName, setCustomerName] = useState<string>(customer?.name || '');
  const [holdNotes, setHoldNotes] = useState<string>(cartNotes || '');
  const [isHolding, setIsHolding] = useState<boolean>(false);

  useEffect(() => {
    if (isOpen) {
      setCustomerName(customer?.name || '');
      setHoldNotes(cartNotes || '');
      loadHeldBills();
    }
  }, [isOpen, customer, cartNotes]);

  const loadHeldBills = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<{ holdBills: HoldBill[] }>('/hold-bills');
      setHeldBills(res.holdBills || []);
    } catch (err: any) {
      setError(err.message || 'Failed to load held bills');
    } finally {
      setIsLoading(false);
    }
  };

  const handleHoldCurrentCart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0) return;

    setIsHolding(true);
    setError(null);

    try {
      await api.post('/hold-bills', {
        customerName: customerName.trim() || undefined,
        customerPhone: customer?.phone || undefined,
        notes: holdNotes.trim() || undefined,
        items: items.map((i) => ({
          productId: i.productId,
          quantity: i.quantity
        }))
      });

      clearCart();
      await loadHeldBills();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to hold current bill');
    } finally {
      setIsHolding(false);
    }
  };

  const handleResumeBill = async (billId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<{ holdBill: HoldBill }>(`/hold-bills/${billId}/resume`);
      loadHeldBillIntoCart(res.holdBill);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to resume held bill');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDiscardBill = async (billId: string) => {
    if (!window.confirm('Are you sure you want to discard this held bill?')) return;

    try {
      await api.post(`/hold-bills/${billId}/discard`);
      setHeldBills((prev) => prev.filter((b) => b.id !== billId));
    } catch (err: any) {
      setError(err.message || 'Failed to discard held bill');
    }
  };

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Pause className="w-5 h-5 text-amber-400" />
            <h2 className="font-bold text-sm tracking-wide">Hold & Resume Bills</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="m-4 mb-0 p-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-5 space-y-5 overflow-y-auto flex-1 text-xs">
          {/* Hold Current Cart Form */}
          {items.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-3">
              <span className="font-bold text-slate-800 text-xs block">
                Hold Current Cart ({items.length} items)
              </span>

              <form onSubmit={handleHoldCurrentCart} className="space-y-2">
                <div>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Customer Name or identifier (optional)"
                    className="w-full px-3 py-1.5 border border-slate-300 rounded text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <input
                    type="text"
                    value={holdNotes}
                    onChange={(e) => setHoldNotes(e.target.value)}
                    placeholder="Reason / Notes (e.g. Patient stepped out to ATM)"
                    className="w-full px-3 py-1.5 border border-slate-300 rounded text-xs focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isHolding}
                  className="w-full py-2 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded text-xs flex items-center justify-center space-x-1.5 transition-colors"
                >
                  {isHolding ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Pause className="w-3.5 h-3.5" />
                  )}
                  <span>Confirm Hold (Clears active cart)</span>
                </button>
              </form>
            </div>
          )}

          {/* List of Held Bills */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="font-bold text-slate-700">Currently Held Bills</span>
              <button
                type="button"
                onClick={loadHeldBills}
                className="text-[11px] text-emerald-700 hover:underline"
              >
                Refresh List
              </button>
            </div>

            {isLoading ? (
              <div className="p-6 text-center text-slate-400 flex items-center justify-center space-x-2">
                <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                <span>Loading held bills...</span>
              </div>
            ) : heldBills.length === 0 ? (
              <div className="p-6 text-center text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
                No bills currently on hold.
              </div>
            ) : (
              <div className="space-y-2">
                {heldBills.map((hb) => (
                  <div
                    key={hb.id}
                    className="p-3 bg-white border border-slate-200 rounded-lg shadow-2xs flex items-center justify-between hover:border-slate-300 transition-colors"
                  >
                    <div className="space-y-0.5">
                      <div className="flex items-center space-x-2">
                        <span className="font-bold text-slate-900">{hb.holdNo}</span>
                        {hb.customerName && (
                          <span className="text-slate-600 font-medium">({hb.customerName})</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {hb.itemCount} items | Est. {formatMoney(hb.estimatedTotal)}
                        {hb.notes && <span className="italic ml-2">"{hb.notes}"</span>}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Held at: {new Date(hb.createdAt).toLocaleTimeString()}
                      </div>
                    </div>

                    <div className="flex items-center space-x-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleResumeBill(hb.id)}
                        className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded flex items-center space-x-1 transition-colors"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Resume</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDiscardBill(hb.id)}
                        title="Discard"
                        className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 border border-slate-300 text-slate-700 rounded text-xs font-semibold hover:bg-slate-100"
          >
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
