import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import { usePos } from '../context/PosContext.js';
import { useAuth } from '../context/AuthContext.js';
import { ProductSearch } from './ProductSearch.js';
import { CartTable } from './CartTable.js';
import { CartSummary } from './CartSummary.js';
import { CustomerDialog } from './CustomerDialog.js';
import { RxModal } from './RxModal.js';
import { PaymentDialog } from './PaymentDialog.js';
import { HoldBillsModal } from './HoldBillsModal.js';
import { ShortcutHelpModal } from './ShortcutHelpModal.js';
import { ProductSearchResult, ReceiptData } from '../types/pos.js';

// Lazy-load thermal receipt modal for bundle performance
const ReceiptModal = lazy(() =>
  import('./ReceiptModal.js').then((m) => ({ default: m.ReceiptModal }))
);

export const PosBillingView: React.FC<{ isShortcutsOpen: boolean; setIsShortcutsOpen: (open: boolean) => void }> = ({
  isShortcutsOpen,
  setIsShortcutsOpen
}) => {
  const {
    items,
    customer,
    setCustomer,
    hasRxItems,
    doctorName,
    patientName,
    setRxDetails,
    addItem,
    clearCart,
    priceChangeWarning,
    setPriceChangeWarning
  } = usePos();
  const { user } = useAuth();

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Modal visibility states
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [isRxModalOpen, setIsRxModalOpen] = useState(false);
  const [isPaymentModalOpen, setIsPaymentModalOpen] = useState(false);
  const [isHoldModalOpen, setIsHoldModalOpen] = useState(false);
  const [isReceiptModalOpen, setIsReceiptModalOpen] = useState(false);
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);

  // Check if any modal is currently open
  const isAnyModalOpen =
    isCustomerModalOpen ||
    isRxModalOpen ||
    isPaymentModalOpen ||
    isHoldModalOpen ||
    isReceiptModalOpen ||
    isShortcutsOpen ||
    isClearConfirmOpen;

  // Auto-focus search input when no modals are open
  useEffect(() => {
    if (!isAnyModalOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    }
  }, [isAnyModalOpen]);

  // Global hotkeys listener (F2, F4, F8, F9, Esc, Ctrl+Delete)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Esc closes whichever modal is open
      if (e.key === 'Escape') {
        if (isCustomerModalOpen) setIsCustomerModalOpen(false);
        else if (isRxModalOpen) setIsRxModalOpen(false);
        else if (isPaymentModalOpen) setIsPaymentModalOpen(false);
        else if (isHoldModalOpen) setIsHoldModalOpen(false);
        else if (isReceiptModalOpen) setIsReceiptModalOpen(false);
        else if (isShortcutsOpen) setIsShortcutsOpen(false);
        else if (isClearConfirmOpen) setIsClearConfirmOpen(false);
        return;
      }

      // If a modal is open, let the modal handle internal keystrokes
      if (isAnyModalOpen) return;

      if (e.key === 'F2') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'F4') {
        e.preventDefault();
        setIsCustomerModalOpen(true);
      } else if (e.key === 'F8') {
        e.preventDefault();
        setIsHoldModalOpen(true);
      } else if (e.key === 'F9') {
        e.preventDefault();
        handleTriggerPayment();
      } else if (e.ctrlKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        if (items.length > 0) {
          setIsClearConfirmOpen(true);
        }
      }
    },
    [
      isAnyModalOpen,
      isCustomerModalOpen,
      isRxModalOpen,
      isPaymentModalOpen,
      isHoldModalOpen,
      isReceiptModalOpen,
      isShortcutsOpen,
      isClearConfirmOpen,
      items.length
    ]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleSelectProduct = async (product: ProductSearchResult) => {
    const res = await addItem(product, 1);
    if (!res.success && res.message) {
      alert(res.message);
    }
  };

  const handleTriggerPayment = () => {
    if (items.length === 0) return;

    // Check prescription enforcement:
    // If cart has Rx items and doctor/patient details are missing, open RxModal
    if (hasRxItems && (!doctorName.trim() || !patientName.trim())) {
      setIsRxModalOpen(true);
      return;
    }

    // If role is cashier and cart has Rx items, open RxModal which displays blocking message
    if (hasRxItems && user?.role === 'cashier') {
      setIsRxModalOpen(true);
      return;
    }

    setIsPaymentModalOpen(true);
  };

  const handleRxConfirmed = (doc: string, pat: string) => {
    setRxDetails(doc, pat);
    setIsRxModalOpen(false);
    setIsPaymentModalOpen(true);
  };

  const handlePaymentSuccess = (receipt: ReceiptData) => {
    setReceiptData(receipt);
    setIsReceiptModalOpen(true);
  };

  return (
    <div className="max-w-[1440px] mx-auto p-3 flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* Top Search Bar */}
      <div className="mb-3 shrink-0">
        {priceChangeWarning && (
          <div className="mb-2 p-2.5 bg-amber-50 border border-amber-300 text-amber-900 rounded-lg flex items-center justify-between text-xs animate-fadeIn">
            <div className="flex items-center space-x-2">
              <span className="font-bold">⚠️</span>
              <span>{priceChangeWarning}</span>
            </div>
            <button
              onClick={() => setPriceChangeWarning(null)}
              className="text-amber-800 hover:text-black font-bold text-sm px-1.5 cursor-pointer"
            >
              ✕
            </button>
          </div>
        )}
        <ProductSearch onSelectProduct={handleSelectProduct} inputRef={searchInputRef} />
      </div>

      {/* Main Billing Workspace (Grid designed for 1366x768 screens) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-3 min-h-0 overflow-hidden">
        {/* Left: Cart Items Table (70% width on desktop) */}
        <div className="lg:col-span-8 flex flex-col min-h-0 h-full">
          <CartTable />
        </div>

        {/* Right: Cart Summary, Customer, and Checkout Actions (30% width) */}
        <div className="lg:col-span-4 flex flex-col min-h-0 h-full">
          <CartSummary
            onOpenCustomerDialog={() => setIsCustomerModalOpen(true)}
            onOpenHoldDialog={() => setIsHoldModalOpen(true)}
            onOpenPaymentDialog={handleTriggerPayment}
            onConfirmClearCart={() => setIsClearConfirmOpen(true)}
          />
        </div>
      </div>

      {/* Modals & Dialogs */}
      <CustomerDialog
        isOpen={isCustomerModalOpen}
        onClose={() => setIsCustomerModalOpen(false)}
        onSelectCustomer={setCustomer}
        currentCustomer={customer}
      />

      <RxModal
        isOpen={isRxModalOpen}
        onClose={() => setIsRxModalOpen(false)}
        onConfirm={handleRxConfirmed}
      />

      <PaymentDialog
        isOpen={isPaymentModalOpen}
        onClose={() => setIsPaymentModalOpen(false)}
        onSuccess={handlePaymentSuccess}
      />

      <HoldBillsModal
        isOpen={isHoldModalOpen}
        onClose={() => setIsHoldModalOpen(false)}
      />

      <Suspense fallback={null}>
        <ReceiptModal
          receipt={receiptData}
          isOpen={isReceiptModalOpen}
          onClose={() => {
            setIsReceiptModalOpen(false);
            setReceiptData(null);
            searchInputRef.current?.focus();
          }}
        />
      </Suspense>

      <ShortcutHelpModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />

      {/* Clear Cart Confirmation Dialog */}
      {isClearConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
        >
          <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-sm p-5 text-center">
            <h3 className="text-sm font-bold text-slate-900 mb-1">Clear Entire Cart?</h3>
            <p className="text-xs text-slate-500 mb-4">
              All {items.length} items in the current cart will be removed.
            </p>
            <div className="flex justify-center space-x-2">
              <button
                type="button"
                onClick={() => setIsClearConfirmOpen(false)}
                className="px-4 py-2 text-xs border border-slate-300 text-slate-700 font-semibold rounded-lg hover:bg-slate-50"
              >
                Cancel (Esc)
              </button>
              <button
                type="button"
                onClick={() => {
                  clearCart();
                  setIsClearConfirmOpen(false);
                  searchInputRef.current?.focus();
                }}
                className="px-4 py-2 text-xs bg-red-600 hover:bg-red-500 text-white font-bold rounded-lg shadow-xs"
              >
                Clear Cart
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
