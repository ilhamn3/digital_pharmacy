import { Request } from 'express';

export type UserRole = 'owner' | 'pharmacist' | 'cashier';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  mustChangePassword: boolean;
}

export interface AccessTokenPayload {
  sub: string; // User ID
  username: string;
  fullName: string;
  role: UserRole;
  mustChangePassword: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  rawToken?: string;
}

// Role permission mapping
export const ROLE_PERMISSIONS = {
  owner: {
    canManageUsers: true,
    canViewAuditLogs: true,
    canManageSettings: true,
    canCreatePurchases: true,
    canAdjustStock: true,
    canPerformBilling: true,
    canProcessReturns: true,
    canViewCostPrices: true,
  },
  pharmacist: {
    canManageUsers: false,
    canViewAuditLogs: false,
    canManageSettings: false,
    canCreatePurchases: true,
    canAdjustStock: true,
    canPerformBilling: true,
    canProcessReturns: true,
    canViewCostPrices: true,
  },
  cashier: {
    canManageUsers: false,
    canViewAuditLogs: false,
    canManageSettings: false,
    canCreatePurchases: false,
    canAdjustStock: false,
    canPerformBilling: true,
    canProcessReturns: false,
    canViewCostPrices: false,
  }
} as const;

export type PermissionKey = keyof typeof ROLE_PERMISSIONS['owner'];
