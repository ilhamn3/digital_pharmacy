import React from 'react';
import { Keyboard, X } from 'lucide-react';

interface ShortcutHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ShortcutHelpModal: React.FC<ShortcutHelpModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const shortcuts = [
    { key: 'F2', desc: 'Focus medicine & barcode search input immediately from anywhere' },
    { key: 'F4', desc: 'Open customer selection and quick-registration modal' },
    { key: 'F8', desc: 'Hold current cart and clear screen for next waiting patient' },
    { key: 'F9', desc: 'Open payment dialog and finalize checkout' },
    { key: 'Esc', desc: 'Close any open modal or dismiss search autocomplete' },
    { key: 'Ctrl + Del', desc: 'Clear entire cart (with confirmation prompt)' },
    { key: 'Arrow Keys', desc: 'Navigate up and down through medicine search results' },
    { key: 'Enter', desc: 'Add selected medicine to cart or trigger barcode scan lookup' }
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
    >
      <div className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Keyboard className="w-5 h-5 text-emerald-400" />
            <h2 className="font-bold text-sm tracking-wide">POS Keyboard Shortcuts</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 text-xs space-y-2">
          <p className="text-slate-500 mb-3">
            The Lanka Health POS terminal is designed to be operated 100% keyboard-first without touching a mouse.
          </p>

          <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
            {shortcuts.map((s, idx) => (
              <div key={idx} className="p-2.5 flex items-center justify-between bg-white hover:bg-slate-50">
                <span className="text-slate-700 font-medium">{s.desc}</span>
                <kbd className="px-2 py-1 bg-slate-100 text-slate-800 font-mono font-bold text-xs rounded border border-slate-300 shadow-2xs shrink-0 ml-3">
                  {s.key}
                </kbd>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded text-xs transition-colors"
          >
            Got it (Esc)
          </button>
        </div>
      </div>
    </div>
  );
};
