import React, { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export const OfflineBanner: React.FC = () => {
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="alert"
      className="bg-amber-600 text-white px-4 py-2 flex items-center justify-center space-x-2 text-sm font-medium shadow-md sticky top-0 z-50 animate-pulse"
    >
      <WifiOff className="w-4 h-4" />
      <span>Offline Mode — Network connection lost. Checkout requires an active server connection.</span>
    </div>
  );
};
