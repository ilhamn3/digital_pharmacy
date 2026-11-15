export type UserRole = 'owner' | 'pharmacist' | 'cashier';

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword?: boolean;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export interface LoginResponse {
  message: string;
  user: User;
  accessToken: string;
}
