import React, { useState } from 'react';
import { usePos } from '../context/PosContext.js';
import { useAuth } from '../context/AuthContext.js';
import { Trash2, AlertCircle, Calendar, Layers, ChevronDown, ChevronRight, Plus, Minus } from 'lucide-react';
import { formatMoney } from '../utils/cartMath.js';

export const CartTable: React.FC = () => {
  const { items, updateItemQty, updateItemDiscount, removeItem } = usePos();
  const { user } = useAuth();
  const [expandedBatches, setExpandedBatches] = useState<Record<string, boolean>>({});

  const isCashier = user?.role === 'cashier';

  const toggleExpand = (productId: string) => {
    setExpandedBatches((prev) => ({
      ...prev,
      [productId]: !prev[productId]
    }));
  };

  const getExpiryBadge = (expiryDateStr?: string | null) => {
    if (!expiryDateStr) return null;

    try {
      const expDate = new Date(expiryDateStr);
      const today = new Date();
      const diffMs = expDate.getTime() - today.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (diffDays <= 0) {
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800 border border-red-300">
            <AlertCircle className="w-3 h-3 text-red-600" />
            <span>EXPIRED ({expiryDateStr})</span>
          </span>
        );
      }
      if (diffDays <= 30) {
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-50 text-red-700 border border-red-200">
            <AlertCircle className="w-3 h-3 text-red-600" />
            <span>Exp: {expiryDateStr} ({diffDays}d)</span>
          </span>
        );
      }
      if (diffDays <= 90) {
        return (
          <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
            <Calendar className="w-3 h-3 text-amber-600" />
            <span>Exp: {expiryDateStr} ({diffDays}d)</span>
          </span>
        );
      }

      return (
        <span className="inline-flex items-center space-x-1 text-[11px] text-slate-500">
          <Calendar className="w-3 h-3 text-slate-400" />
          <span>Exp: {expiryDateStr}</span>
        </span>
      );
    } catch {
      return null;
    }
  };

  if (items.length === 0) {
    return (
      <div className="h-full min-h-[300px] flex flex-col items-center justify-center p-8 text-center text-slate-400 bg-white rounded-lg border border-dashed border-slate-300">
        <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
          🛒
        </div>
        <p className="font-semibold text-slate-600 text-sm">Cart is currently empty</p>
        <p className="text-xs text-slate-400 mt-1 max-w-sm">
          Scan a barcode or press <kbd className="px-1.5 py-0.5 bg-slate-100 text-slate-600 border border-slate-300 rounded text-[10px] font-mono">F2</kbd> to search and add medicines to the cart.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden flex flex-col h-full">
      <div className="overflow-x-auto flex-1">
        <table className="w-full text-left text-xs border-collapse">
          <thead>
            <tr className="bg-slate-100 text-slate-600 font-semibold border-b border-slate-200 select-none">
              <th className="py-2.5 px-3 w-10 text-center">#</th>
              <th className="py-2.5 px-3">Product / Medicine</th>
              <th className="py-2.5 px-3 w-28 text-right">Price (MRP)</th>
              <th className="py-2.5 px-3 w-36 text-center">Quantity</th>
              <th className="py-2.5 px-3 w-32 text-right">Discount</th>
              <th className="py-2.5 px-3 w-32 text-right">Line Total</th>
              <th className="py-2.5 px-3 w-10 text-center"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 font-medium">
            {items.map((item, idx) => {
              const isExpanded = !!expandedBatches[item.productId];

              return (
                <React.Fragment key={item.productId}>
                  <tr className="hover:bg-slate-50/80 transition-colors">
                    {/* Index */}
                    <td className="py-2.5 px-3 text-center text-slate-400 text-[11px]">
                      {idx + 1}
                    </td>

                    {/* Product Details */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center space-x-1.5">
                        <span className="font-semibold text-slate-800 text-sm">
                          {item.productName}
                        </span>
                        {item.isRxRequired && (
                          <span className="px-1 py-0.2 rounded text-[9px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                            Rx
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-0.5">
                        {item.genericName && (
                          <span className="text-[11px] text-slate-500 italic">
                            {item.genericName}
                          </span>
                        )}
                        {item.barcode && (
                          <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1 rounded">
                            {item.barcode}
                          </span>
                        )}
                        {getExpiryBadge(item.nearestExpiryDate)}

                        {/* FEFO Batch Dropdown toggle - Hidden for Cashier */}
                        {!isCashier && item.batches && item.batches.length > 0 && (
                          <button
                            type="button"
                            onClick={() => toggleExpand(item.productId)}
                            className="inline-flex items-center space-x-1 text-[10px] text-blue-600 hover:text-blue-800 font-medium hover:underline ml-1"
                          >
                            <Layers className="w-3 h-3" />
                            <span>{item.batches.length} Batches (FEFO)</span>
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Unit Price */}
                    <td className="py-2.5 px-3 text-right font-mono text-slate-700">
                      {formatMoney(item.unitPrice)}
                    </td>

                    {/* Quantity Selector */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center justify-center space-x-1">
                        <button
                          type="button"
                          onClick={() => updateItemQty(item.productId, item.quantity - 1)}
                          className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center border border-slate-300 transition-colors"
                        >
                          <Minus className="w-3 h-3" />
                        </button>

                        <input
                          type="number"
                          step={item.allowFractionalQty ? '0.1' : '1'}
                          min="1"
                          max={item.availableStock}
                          value={item.quantity}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            updateItemQty(item.productId, val);
                          }}
                          className="w-16 h-7 text-center font-bold text-slate-800 border border-slate-300 rounded focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono text-xs"
                        />

                        <button
                          type="button"
                          onClick={() => updateItemQty(item.productId, item.quantity + 1)}
                          disabled={item.quantity >= item.availableStock}
                          className="w-7 h-7 rounded bg-slate-100 hover:bg-slate-200 disabled:opacity-40 text-slate-700 flex items-center justify-center border border-slate-300 transition-colors"
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="text-[10px] text-center text-slate-400 mt-0.5">
                        Stock: {item.availableStock} {item.unit}s
                      </div>
                    </td>

                    {/* Line Discount */}
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end space-x-1">
                        <input
                          type="number"
                          min="0"
                          step={item.discountType === 'percent' ? '1' : '10'}
                          value={item.discountValue || ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            updateItemDiscount(item.productId, item.discountType, val);
                          }}
                          placeholder="0"
                          className="w-16 h-7 text-right px-1.5 py-0.5 text-xs border border-slate-300 rounded focus:border-emerald-500 focus:outline-none font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const newType = item.discountType === 'percent' ? 'amount' : 'percent';
                            updateItemDiscount(item.productId, newType, item.discountValue);
                          }}
                          className="w-7 h-7 text-[10px] font-bold bg-slate-100 hover:bg-slate-200 rounded border border-slate-300 text-slate-700 transition-colors"
                        >
                          {item.discountType === 'percent' ? '%' : 'Rs'}
                        </button>
                      </div>
                      {Number(item.discountAmount) > 0 && (
                        <div className="text-[10px] text-emerald-600 font-mono mt-0.5">
                          -Rs. {item.discountAmount}
                        </div>
                      )}
                    </td>

                    {/* Line Total */}
                    <td className="py-2.5 px-3 text-right font-mono font-bold text-slate-900 text-sm">
                      {formatMoney(item.lineTotal)}
                    </td>

                    {/* Remove Action */}
                    <td className="py-2.5 px-3 text-center">
                      <button
                        type="button"
                        onClick={() => removeItem(item.productId)}
                        title="Remove Item"
                        className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>

                  {/* Expanded FEFO Batches (Owner & Pharmacist Only) */}
                  {!isCashier && isExpanded && item.batches && (
                    <tr className="bg-blue-50/40">
                      <td colSpan={7} className="px-6 py-2.5 border-y border-blue-100">
                        <div className="text-xs">
                          <span className="font-semibold text-blue-900 mb-1 block">
                            Active Batches in FEFO Order (Nearest Expiry First):
                          </span>
                          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                            {item.batches.map((b) => (
                              <div
                                key={b.id}
                                className="p-2 bg-white rounded border border-blue-200 shadow-2xs text-[11px]"
                              >
                                <div className="flex justify-between font-bold text-slate-800">
                                  <span>Batch: {b.batchNo}</span>
                                  <span>MRP: {formatMoney(b.mrp)}</span>
                                </div>
                                <div className="flex justify-between text-slate-500 mt-0.5">
                                  <span>Exp: {b.expiryDate}</span>
                                  <span className="font-medium text-emerald-700">
                                    Stock: {b.currentQuantity}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
