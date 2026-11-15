import React, { useState, Suspense, lazy } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.js';
import { PosProvider } from './context/PosContext.js';
import { OfflineBanner } from './components/OfflineBanner.js';
import { Navbar } from './components/Navbar.js';
import { LoginView } from './components/LoginView.js';
import { PosBillingView } from './components/PosBillingView.js';
import { Loader2 } from 'lucide-react';

// Lazy-load secondary views for bundle optimization
const SalesHistoryView = lazy(() =>
  import('./components/SalesHistoryView.js').then((m) => ({ default: m.SalesHistoryView }))
);

const MainLayout: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const [activeTab, setActiveTab] = useState<'pos' | 'sales'>('pos');
  const [isShortcutsOpen, setIsShortcutsOpen] = useState<boolean>(false);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white space-y-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-500 flex items-center justify-center font-bold text-xl text-white shadow-md">
          Rx
        </div>
        <div className="flex items-center space-x-2 text-xs text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-500" />
          <span>Connecting to Lanka Health POS...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginView />;
  }

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans select-none">
      <OfflineBanner />
      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onOpenShortcuts={() => setIsShortcutsOpen(true)}
      />

      <main className="flex-1 overflow-hidden">
        {activeTab === 'pos' ? (
          <PosBillingView
            isShortcutsOpen={isShortcutsOpen}
            setIsShortcutsOpen={setIsShortcutsOpen}
          />
        ) : (
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-64 text-slate-500 font-medium">
                <Loader2 className="w-5 h-5 animate-spin mr-2 text-emerald-600" />
                <span>Loading Sales History...</span>
              </div>
            }
          >
            <SalesHistoryView />
          </Suspense>
        )}
      </main>
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <PosProvider>
        <MainLayout />
      </PosProvider>
    </AuthProvider>
  );
}
