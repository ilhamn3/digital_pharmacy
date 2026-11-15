import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext.js';
import { Lock, User, AlertCircle, Loader2 } from 'lucide-react';

export const LoginView: React.FC = () => {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err.message || 'Login failed. Please check your credentials.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-md bg-slate-800 rounded-xl shadow-xl border border-slate-700 p-8">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-emerald-500 mx-auto flex items-center justify-center font-bold text-2xl text-white shadow-md mb-3">
            Rx
          </div>
          <h1 className="text-xl font-bold text-white tracking-wide">Lanka Health Pharmacy</h1>
          <p className="text-xs text-slate-400 mt-1">Core Point of Sale System</p>
        </div>

        {/* Error Alert */}
        {error && (
          <div
            role="alert"
            className="mb-6 p-3 bg-red-950/80 border border-red-700/60 rounded-lg flex items-start space-x-2 text-xs text-red-200 animate-fadeIn"
          >
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Username
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <User className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. cashier or pharmacist"
                autoFocus
                disabled={isSubmitting}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
              Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={isSubmitting}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-colors"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full mt-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 text-white font-medium py-2.5 px-4 rounded-lg text-sm shadow-sm transition-colors flex items-center justify-center space-x-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Signing in...</span>
              </>
            ) : (
              <span>Sign In</span>
            )}
          </button>
        </form>

        {/* Demo Credentials Reminder */}
        <div className="mt-8 pt-6 border-t border-slate-700 text-center">
          <p className="text-[11px] text-slate-400">
            Default credentials for local testing:
          </p>
          <div className="flex justify-center space-x-3 mt-2 text-[10px] text-slate-300 font-mono">
            <span className="bg-slate-900 px-2 py-1 rounded border border-slate-700">admin</span>
            <span className="bg-slate-900 px-2 py-1 rounded border border-slate-700">pharmacist</span>
            <span className="bg-slate-900 px-2 py-1 rounded border border-slate-700">cashier</span>
          </div>
        </div>
      </div>
    </div>
  );
};
