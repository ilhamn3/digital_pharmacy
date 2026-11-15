import React, { useState } from 'react';
import { formatMoney } from '../utils/cartMath.js';
import { api } from '../utils/api.js';
import { Printer, RefreshCw, X } from 'lucide-react';

interface ReceiptModalProps {
  receipt: any;
  isOpen: boolean;
  onClose: () => void;
}

export const ReceiptModal: React.FC<ReceiptModalProps> = ({ receipt: initialReceipt, isOpen, onClose }) => {
  const [receipt, setReceipt] = useState<any>(initialReceipt);
  const [isReprinting, setIsReprinting] = useState<boolean>(false);

  React.useEffect(() => {
    setReceipt(initialReceipt);
  }, [initialReceipt]);

  if (!isOpen || !receipt) return null;

  // Normalize data whether passed from GET /receipt ({ receiptData: { header, sale } }) or direct DTO
  const isWrapper = Boolean(receipt.receiptData?.sale);
  const sale = isWrapper ? receipt.receiptData.sale : (receipt.sale || receipt);
  const header = isWrapper ? receipt.receiptData.header : (receipt.shopDetails || {});

  const isDuplicate = Boolean(receipt.isDuplicate ?? sale.isDuplicate ?? false);
  const reprintCount = Number(receipt.reprintCount ?? sale.reprintCount ?? 0);
  const billNo = receipt.billNo || sale.billNo || 'INV-000000';
  const createdAt = sale.createdAt || receipt.createdAt || new Date().toISOString();
  const cashierName = sale.cashierUsername || sale.cashierName || receipt.cashierName || 'Cashier';
  const customerName = sale.customerName || receipt.customerName || null;
  const doctorName = sale.doctorName || receipt.doctorName || null;
  const patientName = sale.patientName || receipt.patientName || null;
  const items: any[] = sale.items || receipt.items || [];
  const payments: any[] = sale.payments || receipt.payments || [];

  const subtotal = sale.subtotal ?? receipt.subtotal ?? 0;
  const discountAmount = sale.discountAmount ?? receipt.discountAmount ?? 0;
  const taxAmount = sale.taxAmount ?? receipt.taxAmount ?? 0;
  const totalAmount = sale.totalAmount ?? receipt.totalAmount ?? 0;
  const tenderedAmount = sale.tenderedAmount ?? receipt.tenderedAmount ?? 0;
  const changeAmount = sale.changeAmount ?? receipt.changeAmount ?? 0;
  const balanceDue = sale.balanceDue ?? receipt.balanceDue ?? 0;

  const shopName = header.pharmacyName || header.name || 'CITY HEALTH PHARMACY';
  const shopAddress = header.address || 'No. 124, Galle Road, Colombo 03';
  const shopPhone = header.phone || '+94 11 257 8900';
  const shopReg = header.vatReg || header.registrationNo || '104582910-7000';

  const handlePrint = () => {
    window.print();
  };

  const handleReprint = async () => {
    const saleId = sale.id || receipt.saleId;
    if (!saleId) return;
    setIsReprinting(true);
    try {
      const refreshed = await api.get<any>(`/sales/${saleId}/receipt`);
      setReceipt(refreshed);
      // Automatically trigger print dialog
      setTimeout(() => window.print(), 200);
    } catch (err) {
      console.error('Reprint failed:', err);
    } finally {
      setIsReprinting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto animate-fadeIn"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-300 w-full max-w-md overflow-hidden flex flex-col my-8">
        {/* Top Control Bar (Screen only, hidden on print) */}
        <div className="no-print px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center space-x-2">
            <Printer className="w-5 h-5 text-emerald-400" />
            <span className="font-bold text-sm tracking-wide">Receipt Preview</span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleReprint}
              disabled={isReprinting}
              title="Request Official Server Reprint (logs audit)"
              className="px-2.5 py-1 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 rounded border border-slate-700 flex items-center space-x-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isReprinting ? 'animate-spin' : ''}`} />
              <span>Reprint</span>
            </button>

            <button
              onClick={handlePrint}
              className="px-3 py-1 text-xs bg-emerald-600 hover:bg-emerald-500 font-bold text-white rounded flex items-center space-x-1 shadow-xs"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print (80mm)</span>
            </button>

            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Thermal 80mm Receipt Document Container */}
        <div className="p-6 bg-slate-50 flex justify-center overflow-y-auto max-h-[75vh]">
          <div
            id="receipt-print-area"
            className="w-[80mm] max-w-[80mm] bg-white p-4 shadow-sm border border-slate-200 text-black font-mono text-[11px] leading-tight select-text"
          >
            {/* Duplicate Watermark / Notice */}
            {isDuplicate && (
              <div className="text-center font-bold text-red-600 border-2 border-red-600 p-1 mb-2 tracking-widest text-xs uppercase">
                *** DUPLICATE RECEIPT ***
                {reprintCount > 0 && (
                  <span className="block text-[10px] font-normal tracking-normal text-red-500">
                    Reprint #{reprintCount}
                  </span>
                )}
              </div>
            )}

            {/* Header */}
            <div className="text-center mb-3">
              <h1 className="text-sm font-extrabold uppercase tracking-wide">
                {shopName}
              </h1>
              {shopAddress && (
                <p className="text-[10px] text-slate-700 mt-0.5">{shopAddress}</p>
              )}
              {shopPhone && (
                <p className="text-[10px] text-slate-700">Tel: {shopPhone}</p>
              )}
              {shopReg && (
                <p className="text-[9px] text-slate-600">Reg: {shopReg}</p>
              )}
            </div>

            <div className="border-t border-dashed border-slate-400 my-2" />

            {/* Metadata */}
            <div className="space-y-0.5 text-[10px] text-slate-800">
              <div className="flex justify-between">
                <span>Bill No:</span>
                <span className="font-bold">{billNo}</span>
              </div>
              <div className="flex justify-between">
                <span>Date:</span>
                <span>{new Date(createdAt).toLocaleString('en-GB', { timeZone: 'Asia/Colombo' })}</span>
              </div>
              <div className="flex justify-between">
                <span>Cashier:</span>
                <span>{cashierName}</span>
              </div>
              {customerName && (
                <div className="flex justify-between">
                  <span>Customer:</span>
                  <span className="font-bold">{customerName}</span>
                </div>
              )}
              {doctorName && (
                <div className="flex justify-between text-slate-700">
                  <span>Doctor:</span>
                  <span>{doctorName}</span>
                </div>
              )}
              {patientName && (
                <div className="flex justify-between text-slate-700">
                  <span>Patient:</span>
                  <span>{patientName}</span>
                </div>
              )}
            </div>

            <div className="border-t border-dashed border-slate-400 my-2" />

            {/* Line Items Table */}
            <table className="w-full text-left text-[10px] border-collapse mb-2">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="py-1">Item</th>
                  <th className="py-1 text-center">Qty</th>
                  <th className="py-1 text-right">Price</th>
                  <th className="py-1 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((it: any, i: number) => (
                  <tr key={it.id || i}>
                    <td className="py-1 pr-1">
                      <div className="font-bold leading-none">{it.productName}</div>
                      {it.batchNo && (
                        <div className="text-[9px] text-slate-500 mt-0.5">
                          B: {it.batchNo} {it.expiryDate ? `| Exp: ${String(it.expiryDate).split('T')[0]}` : ''}
                        </div>
                      )}
                    </td>
                    <td className="py-1 text-center font-bold">{it.quantity}</td>
                    <td className="py-1 text-right">{formatMoney(it.unitPrice)}</td>
                    <td className="py-1 text-right font-bold">{formatMoney(it.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="border-t border-dashed border-slate-400 my-2" />

            {/* Financial Summary */}
            <div className="space-y-1 text-[10px]">
              <div className="flex justify-between">
                <span>Subtotal:</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              {Number(discountAmount) > 0 && (
                <div className="flex justify-between font-bold">
                  <span>Total Discount:</span>
                  <span>- {formatMoney(discountAmount)}</span>
                </div>
              )}
              {Number(taxAmount) > 0 && (
                <div className="flex justify-between">
                  <span>Tax:</span>
                  <span>{formatMoney(taxAmount)}</span>
                </div>
              )}
              <div className="flex justify-between font-extrabold text-xs pt-1 border-t border-slate-300">
                <span>NET TOTAL:</span>
                <span>{formatMoney(totalAmount)}</span>
              </div>
            </div>

            <div className="border-t border-dashed border-slate-400 my-2" />

            {/* Payments & Change */}
            <div className="space-y-1 text-[10px]">
              {payments.map((p: any, idx: number) => (
                <div key={idx} className="flex justify-between text-slate-800">
                  <span className="capitalize">{(p.type || p.payment_type || 'Payment').replace('_', ' ')}:</span>
                  <span>{formatMoney(p.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between">
                <span>Tendered:</span>
                <span>{formatMoney(tenderedAmount)}</span>
              </div>
              <div className="flex justify-between font-bold">
                <span>Change:</span>
                <span>{formatMoney(changeAmount)}</span>
              </div>
              {Number(balanceDue) > 0 && (
                <div className="flex justify-between font-bold text-red-600">
                  <span>Balance Due:</span>
                  <span>{formatMoney(balanceDue)}</span>
                </div>
              )}
            </div>

            <div className="border-t border-dashed border-slate-400 my-3" />

            {/* Footer */}
            <div className="text-center text-[9px] text-slate-600 space-y-1">
              <p>{receipt.receiptSettings?.footer || 'Thank you for your visit. Get well soon!'}</p>
              <p>Keep medicines out of reach of children.</p>
              <p className="text-[8px] text-slate-400 mt-2">Software by Lanka Health POS Phase 1</p>
            </div>
          </div>
        </div>

        {/* Bottom Button (Screen only) */}
        <div className="no-print p-4 bg-slate-100 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-lg text-xs transition-colors"
          >
            Done / Next Sale (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
