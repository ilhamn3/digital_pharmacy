import React from 'react';
import { useAuth } from '../context/AuthContext.js';
import { ShoppingCart, History, Keyboard, LogOut, User as UserIcon } from 'lucide-react';
import { UserRole } from '../types/auth.js';

interface NavbarProps {
  activeTab: 'pos' | 'sales';
  setActiveTab: (tab: 'pos' | 'sales') => void;
  onOpenShortcuts: () => void;
}

const ROLE_BADGES: Record<UserRole, { label: string; bg: string; text: string; border: string }> = {
  owner: {
    label: 'OWNER',
    bg: 'bg-purple-950',
    text: 'text-purple-300',
    border: 'border-purple-700'
  },
  pharmacist: {
    label: 'PHARMACIST',
    bg: 'bg-blue-950',
    text: 'text-blue-300',
    border: 'border-blue-700'
  },
  cashier: {
    label: 'CASHIER',
    bg: 'bg-emerald-950',
    text: 'text-emerald-300',
    border: 'border-emerald-700'
  }
};

export const Navbar: React.FC<NavbarProps> = ({ activeTab, setActiveTab, onOpenShortcuts }) => {
  const { user, logout } = useAuth();

  if (!user) return null;

  const roleStyle = ROLE_BADGES[user.role] || ROLE_BADGES.cashier;

  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 shadow-sm sticky top-0 z-40 select-none">
      <div className="max-w-[1440px] mx-auto px-4 h-14 flex items-center justify-between">
        {/* Brand & Store Info */}
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500 flex items-center justify-center font-bold text-white shadow-sm text-sm">
              Rx
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide leading-none text-slate-100">
                Lanka Health Pharmacy
              </h1>
              <p className="text-[10px] text-slate-400 leading-tight mt-0.5">Core POS Terminal</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <nav className="flex space-x-1 pl-4 border-l border-slate-800">
            <button
              onClick={() => setActiveTab('pos')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === 'pos'
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              <span>POS Billing</span>
              <kbd className="hidden sm:inline-block ml-1 px-1 py-0.2 bg-slate-900 text-[9px] text-slate-400 rounded border border-slate-700">
                F2
              </kbd>
            </button>

            <button
              onClick={() => setActiveTab('sales')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === 'sales'
                  ? 'bg-slate-800 text-emerald-400 border border-slate-700'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <History className="w-3.5 h-3.5" />
              <span>Sales History</span>
            </button>
          </nav>
        </div>

        {/* Right side: Role badge, Shortcuts, User & Logout */}
        <div className="flex items-center space-x-3 text-xs">
          {/* Shortcuts trigger */}
          <button
            onClick={onOpenShortcuts}
            title="Keyboard Shortcuts"
            className="flex items-center space-x-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors"
          >
            <Keyboard className="w-3.5 h-3.5 text-slate-400" />
            <span className="hidden md:inline">Shortcuts</span>
          </button>

          {/* Role badge */}
          <span
            className={`px-2 py-0.5 rounded-full text-[10px] font-bold border tracking-wider ${roleStyle.bg} ${roleStyle.text} ${roleStyle.border}`}
          >
            {roleStyle.label}
          </span>

          {/* User info */}
          <div className="flex items-center space-x-1.5 text-slate-300">
            <UserIcon className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-medium max-w-[120px] truncate">{user.fullName || user.username}</span>
          </div>

          {/* Logout */}
          <button
            onClick={logout}
            title="Sign out"
            className="p-1.5 rounded-md text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
