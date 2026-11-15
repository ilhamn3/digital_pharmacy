import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Barcode, AlertTriangle, Loader2 } from 'lucide-react';
import { ProductSearchResult } from '../types/pos.js';
import { api } from '../utils/api.js';
import { formatMoney } from '../utils/cartMath.js';

interface ProductSearchProps {
  onSelectProduct: (product: ProductSearchResult) => Promise<void>;
  inputRef?: React.RefObject<HTMLInputElement>;
}

export const ProductSearch: React.FC<ProductSearchProps> = ({ onSelectProduct, inputRef }) => {
  const localRef = useRef<HTMLInputElement>(null);
  const activeInputRef = inputRef || localRef;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Search debounce
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setIsOpen(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsLoading(true);
      try {
        const res = await api.get<{ products: ProductSearchResult[] }>(
          `/products?search=${encodeURIComponent(query.trim())}&limit=10&isActive=true`
        );
        setResults(res.products || []);
        setSelectedIndex(0);
        setIsOpen(true);
      } catch (err) {
        console.error('Product search failed:', err);
      } finally {
        setIsLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [query]);

  // Handle adding product
  const handleAddProduct = useCallback(
    async (product: ProductSearchResult) => {
      const stock = Number(product.totalStock || 0);
      if (stock <= 0) {
        setStatusMessage(`'${product.name}' is out of stock!`);
        setTimeout(() => setStatusMessage(null), 3000);
        return;
      }

      await onSelectProduct(product);
      setQuery('');
      setResults([]);
      setIsOpen(false);
      activeInputRef.current?.focus();
    },
    [onSelectProduct, activeInputRef]
  );

  // Keyboard navigation & Barcode scanner detection
  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % results.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();

      // If dropdown is open and an item is selected
      if (isOpen && results.length > 0) {
        const selected = results[selectedIndex];
        if (selected) {
          await handleAddProduct(selected);
          return;
        }
      }

      // Barcode scanner entered a code or user pressed Enter on text
      if (query.trim()) {
        setIsLoading(true);
        try {
          const res = await api.get<{ products: ProductSearchResult[] }>(
            `/products?search=${encodeURIComponent(query.trim())}&limit=5&isActive=true`
          );

          if (res.products && res.products.length > 0) {
            // Find exact barcode match or top match
            const exactBarcode = res.products.find(
              (p) => p.barcode && p.barcode.toLowerCase() === query.trim().toLowerCase()
            );
            const toAdd = exactBarcode || res.products[0];
            await handleAddProduct(toAdd);
          } else {
            setStatusMessage(`No product found matching "${query.trim()}"`);
            setTimeout(() => setStatusMessage(null), 3000);
          }
        } catch (err) {
          console.error('Scan lookup failed:', err);
        } finally {
          setIsLoading(false);
        }
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  return (
    <div className="relative w-full">
      {/* Search Input Container */}
      <div className="relative flex items-center">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
          <Barcode className="w-5 h-5 text-emerald-600" />
        </div>

        <input
          ref={activeInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (results.length > 0) setIsOpen(true);
          }}
          placeholder="Scan barcode or type medicine name / generic name (F2 to focus)..."
          className="w-full bg-white border border-slate-300 rounded-lg pl-10 pr-10 py-2.5 text-sm text-slate-800 placeholder-slate-400 font-medium focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 shadow-sm transition-all"
        />

        <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
          ) : query ? (
            <button
              onClick={() => {
                setQuery('');
                setResults([]);
                setIsOpen(false);
                activeInputRef.current?.focus();
              }}
              className="text-slate-400 hover:text-slate-600 text-xs px-1"
            >
              ✕
            </button>
          ) : (
            <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded border border-slate-200">
              F2
            </span>
          )}
        </div>
      </div>

      {/* Out of Stock / Status notification toast */}
      {statusMessage && (
        <div
          role="alert"
          className="absolute top-12 left-0 right-0 z-50 bg-amber-50 border border-amber-300 text-amber-900 px-3 py-2 rounded-lg text-xs font-semibold flex items-center space-x-2 shadow-lg animate-fadeIn"
        >
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {/* Autocomplete Dropdown */}
      {isOpen && results.length > 0 && (
        <ul
          role="listbox"
          className="absolute top-12 left-0 right-0 z-50 bg-white border border-slate-200 rounded-lg shadow-xl max-h-80 overflow-y-auto divide-y divide-slate-100"
        >
          {results.map((product, idx) => {
            const isSelected = idx === selectedIndex;
            const stock = Number(product.totalStock || 0);
            const isOutOfStock = stock <= 0;

            return (
              <li
                key={product.id}
                role="option"
                aria-selected={isSelected}
                onMouseDown={() => {
                  if (!isOutOfStock) handleAddProduct(product);
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
                className={`p-3 cursor-pointer transition-colors flex items-center justify-between ${
                  isSelected ? 'bg-emerald-50' : 'hover:bg-slate-50'
                } ${isOutOfStock ? 'opacity-60 bg-slate-50 cursor-not-allowed' : ''}`}
              >
                {/* Left: Product details */}
                <div className="flex-1 min-w-0 pr-4">
                  <div className="flex items-center space-x-2">
                    <span className="font-semibold text-sm text-slate-900 truncate">
                      {product.name}
                    </span>
                    {product.isRxRequired && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                        Rx
                      </span>
                    )}
                  </div>

                  <div className="flex items-center space-x-3 text-xs text-slate-500 mt-0.5">
                    {product.genericName && (
                      <span className="italic truncate">{product.genericName}</span>
                    )}
                    {product.barcode && (
                      <span className="font-mono text-[11px] bg-slate-100 px-1 rounded text-slate-600">
                        {product.barcode}
                      </span>
                    )}
                    <span>
                      Pack: {product.packSize} {product.unit}
                    </span>
                  </div>
                </div>

                {/* Right: Stock & Price */}
                <div className="text-right shrink-0">
                  <div className="font-bold text-sm text-slate-800">
                    {formatMoney(product.minMrp || 0)}
                  </div>
                  <div>
                    {isOutOfStock ? (
                      <span className="inline-block text-[10px] font-bold text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded">
                        Out of stock
                      </span>
                    ) : (
                      <span className="text-xs text-slate-600 font-medium">
                        Stock:{' '}
                        <span className="font-bold text-emerald-700">{product.totalStock}</span>{' '}
                        {product.unit}s
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
