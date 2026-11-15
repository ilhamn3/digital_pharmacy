import React, { useState, useEffect, useRef } from 'react';
import { Customer } from '../types/pos.js';
import { useAuth } from '../context/AuthContext.js';
import { api } from '../utils/api.js';
import { formatMoney } from '../utils/cartMath.js';
import { Search, UserPlus, X, Check, Loader2, UserCheck, AlertCircle } from 'lucide-react';

interface CustomerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCustomer: (customer: Customer | null) => void;
  currentCustomer: Customer | null;
}

export const CustomerDialog: React.FC<CustomerDialogProps> = ({
  isOpen,
  onClose,
  onSelectCustomer,
  currentCustomer
}) => {
  const { user } = useAuth();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<'search' | 'create'>('search');
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick Create Form State
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCreditLimit, setNewCreditLimit] = useState(0);
  const [isCreating, setIsCreating] = useState(false);

  const canSetCreditLimit = user?.role === 'owner' || user?.role === 'pharmacist';

  useEffect(() => {
    if (isOpen) {
      setError(null);
      setTimeout(() => searchInputRef.current?.focus(), 50);
      loadCustomers('');
    }
  }, [isOpen]);

  const loadCustomers = async (searchQuery: string) => {
    setIsLoading(true);
    try {
      const q = searchQuery ? `?search=${encodeURIComponent(searchQuery)}` : '';
      const res = await api.get<{ customers: Customer[] }>(`/customers${q}`);
      setCustomers(res.customers || []);
    } catch (err: any) {
      setError(err.message || 'Failed to search customers');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    loadCustomers(query.trim());
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) {
      setError('Customer name is required.');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const payload: any = {
        name: newName.trim(),
        phone: newPhone.trim() || null,
        creditLimit: canSetCreditLimit ? Number(newCreditLimit || 0) : 0
      };

      const res = await api.post<{ customer: Customer }>('/customers', payload);
      onSelectCustomer(res.customer);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create customer');
    } finally {
      setIsCreating(false);
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
            <UserCheck className="w-5 h-5 text-emerald-400" />
            <h2 className="font-bold text-sm tracking-wide">Customer Selection</h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-slate-200 bg-slate-50 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('search')}
            className={`flex-1 py-2.5 px-4 text-center border-b-2 transition-colors ${
              activeTab === 'search'
                ? 'border-emerald-600 text-emerald-800 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Search Existing
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('create')}
            className={`flex-1 py-2.5 px-4 text-center border-b-2 transition-colors flex items-center justify-center space-x-1 ${
              activeTab === 'create'
                ? 'border-emerald-600 text-emerald-800 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Quick Create</span>
          </button>
        </div>

        {/* Error notification */}
        {error && (
          <div className="m-4 mb-0 p-2.5 bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{error}</span>
          </div>
        )}

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          {activeTab === 'search' ? (
            <div className="space-y-4">
              {/* Search Bar */}
              <form onSubmit={handleSearchSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400 pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by customer name or phone..."
                    className="w-full pl-9 pr-3 py-2 text-xs border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  />
                </div>
                <button
                  type="submit"
                  className="px-3 py-2 bg-slate-800 text-white rounded-lg text-xs font-semibold hover:bg-slate-700 transition-colors"
                >
                  Search
                </button>
              </form>

              {/* Walk-in Customer Option */}
              <button
                type="button"
                onClick={() => {
                  onSelectCustomer(null);
                  onClose();
                }}
                className={`w-full p-2.5 rounded-lg border text-left transition-colors flex items-center justify-between text-xs ${
                  !currentCustomer
                    ? 'border-emerald-500 bg-emerald-50 text-emerald-900 font-bold'
                    : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <div>
                  <span className="block font-semibold">Walk-in Customer (Standard Retail)</span>
                  <span className="text-[11px] text-slate-500 font-normal">
                    Cash / Card payments only. No store credit.
                  </span>
                </div>
                {!currentCustomer && <Check className="w-4 h-4 text-emerald-600" />}
              </button>

              {/* Customers List */}
              <div className="space-y-1.5 max-h-56 overflow-y-auto">
                {isLoading ? (
                  <div className="p-4 text-center text-slate-400 text-xs flex justify-center items-center space-x-2">
                    <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                    <span>Loading customers...</span>
                  </div>
                ) : customers.length === 0 ? (
                  <div className="p-4 text-center text-slate-400 text-xs">
                    No customers found. Switch to "Quick Create" to add one.
                  </div>
                ) : (
                  customers.map((c) => {
                    const isSelected = currentCustomer?.id === c.id;

                    return (
                      <div
                        key={c.id}
                        onClick={() => {
                          onSelectCustomer(c);
                          onClose();
                        }}
                        className={`p-3 rounded-lg border cursor-pointer transition-all flex items-center justify-between text-xs ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <div>
                          <div className="font-bold text-slate-800 text-sm">{c.name}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Phone: {c.phone || 'N/A'}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="font-semibold text-slate-700">
                            Balance: <span className="text-amber-700 font-bold">{formatMoney(c.creditBalance)}</span>
                          </div>
                          <div className="text-[10px] text-slate-500">
                            Limit: {formatMoney(c.creditLimit)}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ) : (
            /* Quick Create Form */
            <form onSubmit={handleCreateCustomer} className="space-y-3 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Customer Name *</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Sunil Shantha"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">Phone Number</label>
                <input
                  type="text"
                  value={newPhone}
                  onChange={(e) => setNewPhone(e.target.value)}
                  placeholder="e.g. 0771234567"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  Credit Limit (Rs.)
                  {!canSetCreditLimit && (
                    <span className="text-slate-400 font-normal ml-1">
                      (Cashier default: Rs. 0.00)
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  min="0"
                  step="100"
                  disabled={!canSetCreditLimit}
                  value={newCreditLimit}
                  onChange={(e) => setNewCreditLimit(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:border-emerald-500 disabled:bg-slate-100 disabled:text-slate-500 font-mono"
                />
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isCreating}
                  className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg transition-colors flex items-center justify-center space-x-2"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Saving Customer...</span>
                    </>
                  ) : (
                    <span>Save & Select Customer</span>
                  )}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
