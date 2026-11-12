import { Response, NextFunction } from 'express';
import { AuthenticatedRequest, UserRole, PermissionKey, ROLE_PERMISSIONS } from '../types/auth.js';

const COST_PRICE_KEYS = new Set([
  'cost_price',
  'unit_cost_price',
  'unit_cost',
  'costprice',
  'unitcostprice',
  'unitcost',
  'total_cost',
  'pack_cost',
  'packcost',
  'purchase_cost',
  'purchasecost',
  'purchase_price',
  'purchaseprice',
  'supplier',
  'supplier_id',
  'supplierid',
  'supplier_name',
  'suppliername',
  'supplier_invoice_no',
  'supplier_balance',
  'cost'
]);

/**
 * Recursively strips cost price fields from outgoing data payloads.
 */
export function stripCostPrices(data: any): any {
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map(stripCostPrices);
  }

  if (typeof data === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(data)) {
      if (COST_PRICE_KEYS.has(key.toLowerCase())) {
        // Omit cost price key completely
        continue;
      }
      cleaned[key] = stripCostPrices(val);
    }
    return cleaned;
  }

  return data;
}

/**
 * Middleware ensuring user has one of the allowed roles.
 */
export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied. Role '${req.user.role}' lacks permission for this resource.`
      });
    }

    next();
  };
}

/**
 * Middleware ensuring user has a specific granular capability.
 */
export function requirePermission(permission: PermissionKey) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Authentication required'
      });
    }

    const hasPermission = ROLE_PERMISSIONS[req.user.role]?.[permission];
    if (!hasPermission) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `Access denied. Required capability: '${permission}'`
      });
    }

    next();
  };
}

/**
 * Interceptor middleware that automatically scrubs cost and purchase prices
 * from all JSON responses when the authenticated user is a cashier.
 */
export function cashierDataSanitizer(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = (body: any) => {
    if (req.user?.role === 'cashier') {
      const sanitizedBody = stripCostPrices(body);
      return originalJson(sanitizedBody);
    }
    return originalJson(body);
  };

  next();
}

