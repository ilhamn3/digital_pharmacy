import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, AuthState, LoginResponse } from '../types/auth.js';
import { api, setAccessToken, setUnauthorizedHandler, refreshAccessToken } from '../utils/api.js';

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const handleUnauthorized = useCallback(() => {
    setUser(null);
    setToken(null);
    setAccessToken(null);
  }, []);

  const checkAuth = useCallback(async () => {
    setIsLoading(true);
    try {
      // First attempt silent refresh via httpOnly cookie
      const newToken = await refreshAccessToken();
      if (newToken) {
        setToken(newToken);
        setAccessToken(newToken);
        // Load user profile from DB
        const meRes = await api.get<{ user: User }>('/auth/me');
        setUser(meRes.user);
      } else {
        setUser(null);
        setToken(null);
        setAccessToken(null);
      }
    } catch (e) {
      console.warn('Initial session check failed:', e);
      setUser(null);
      setToken(null);
      setAccessToken(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(handleUnauthorized);
    checkAuth();
  }, [handleUnauthorized, checkAuth]);

  const login = async (username: string, password: string): Promise<User> => {
    setIsLoading(true);
    try {
      const res = await api.post<LoginResponse>('/auth/login', { username, password });
      setToken(res.accessToken);
      setAccessToken(res.accessToken);
      setUser(res.user);
      return res.user;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch (e) {
      console.warn('Logout API call failed:', e);
    } finally {
      setUser(null);
      setToken(null);
      setAccessToken(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isAuthenticated: !!user,
        isLoading,
        login,
        logout,
        checkAuth
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
