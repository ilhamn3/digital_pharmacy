import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { usePos } from '../context/PosContext.js';
import { FileText, AlertTriangle, ShieldAlert, X } from 'lucide-react';

interface RxModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (doctorName: string, patientName: string) => void;
}

export const RxModal: React.FC<RxModalProps> = ({ isOpen, onClose, onConfirm }) => {
  const { user } = useAuth();
  const { doctorName: initialDoc, patientName: initialPat } = usePos();

  const [doc, setDoc] = useState(initialDoc);
  const [pat, setPat] = useState(initialPat);
  const [error, setError] = useState<string | null>(null);

  const isCashier = user?.role === 'cashier';

  useEffect(() => {
    if (isOpen) {
      setDoc(initialDoc);
      setPat(initialPat);
      setError(null);
    }
  }, [isOpen, initialDoc, initialPat]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isCashier) {
      setError('Pharmacist required: Cashiers cannot dispense prescription medications.');
      return;
    }

    if (!doc.trim() || !pat.trim()) {
      setError('Both Doctor Name and Patient Name are mandatory for prescription items.');
      return;
    }

    onConfirm(doc.trim(), pat.trim());
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 bg-amber-600 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-white" />
            <h2 className="font-bold text-sm tracking-wide">Prescription (Rx) Verification</h2>
          </div>
          <button
            onClick={onClose}
            className="text-amber-200 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Cashier Blocking Banner */}
          {isCashier ? (
            <div
              role="alert"
              className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-xs mb-4"
            >
              <div className="flex items-center space-x-2 font-bold text-sm text-red-900 mb-1">
                <ShieldAlert className="w-5 h-5 text-red-600 shrink-0" />
                <span>Pharmacist or Owner Required</span>
              </div>
              <p>
                Cashiers are not legally permitted to dispense prescription-only medications.
                A licensed Pharmacist or Owner must log in to finalize this prescription sale
                (<code className="font-mono bg-red-100 px-1 py-0.5 rounded">RX_DISPENSING_RESTRICTED</code>).
              </p>
            </div>
          ) : (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 text-xs mb-4 flex items-start space-x-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                This cart contains prescription-only items. Government regulations require recording
                the prescribing doctor and patient details.
              </span>
            </div>
          )}

          {error && (
            <div className="mb-4 p-2.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded font-medium">
              {error}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4 text-xs">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Prescribing Doctor Name *
              </label>
              <input
                type="text"
                disabled={isCashier}
                required
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                placeholder="e.g. Dr. K. Fernando"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500 disabled:bg-slate-100"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                Patient Full Name *
              </label>
              <input
                type="text"
                disabled={isCashier}
                required
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="e.g. Nimal Perera"
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500 disabled:bg-slate-100"
              />
            </div>

            <div className="pt-2 flex justify-end space-x-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 font-medium"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={isCashier}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-300 text-white font-bold rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed"
              >
                Confirm Rx Details
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
