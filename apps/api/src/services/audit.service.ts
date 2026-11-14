import { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import net from 'net';

export interface AuditLogEntry {
  userId?: string | null;
  action: string;
  entity: string;
  entityId: string;
  beforeState?: any;
  afterState?: any;
  ipAddress?: string | null;
  client?: PoolClient;
}

export const MONEY_MUTATION_ACTIONS = new Set([
  'SALE_CREATED',
  'SALE_VOIDED',
  'PURCHASE_CREATED',
  'PURCHASE_VOIDED',
  'PAYMENT_RECEIVED',
  'SUPPLIER_PAYMENT_CREATED',
  'CUSTOMER_PAYMENT_CREATED',
  'STOCK_ADJUSTED',
  'STOCK_ADJUSTMENT_CREATED',
  'SALES_RETURN_CREATED',
  'SUPPLIER_RETURN_CREATED'
]);

const SENSITIVE_KEY_PATTERN = /(password|token|secret|apikey|authorization|cookie)/i;

/**
 * Deeply sanitizes an object to ensure no sensitive credentials or keys are recorded in audit trails.
 * Normalizes keys by stripping hyphens, underscores, and lowercasing.
 * Handles BigInt conversions and enforces a recursion depth limit.
 */
export function sanitizeForAudit(obj: any, depth = 0, maxDepth = 10): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'bigint') {
    return obj.toString();
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (depth > maxDepth) {
    return '[MAX_DEPTH_EXCEEDED]';
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeForAudit(item, depth + 1, maxDepth));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');

    if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof val === 'bigint') {
      sanitized[key] = val.toString();
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitizeForAudit(val, depth + 1, maxDepth);
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

/**
 * Validates an IP address using Node net module (IPv4 and IPv6).
 * Returns normalized string or null if invalid.
 */
export function validateIpAddress(ip?: string | null): string | null {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  return net.isIP(trimmed) !== 0 ? trimmed : null;
}

/**
 * Persists an immutable audit log row.
 * For money mutations, a transaction PoolClient is strictly required.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  // Make client mandatory for money mutations
  if (MONEY_MUTATION_ACTIONS.has(entry.action) && !entry.client) {
    throw new Error(`Database client (PoolClient) is mandatory for transactional money audit log: ${entry.action}`);
  }

  const sanitizedBefore = entry.beforeState !== undefined ? JSON.stringify(sanitizeForAudit(entry.beforeState)) : null;
  const sanitizedAfter = entry.afterState !== undefined ? JSON.stringify(sanitizeForAudit(entry.afterState)) : null;
  const validatedIp = validateIpAddress(entry.ipAddress);

  const query = `
    INSERT INTO audit_logs (
      user_id, action, entity, entity_id, before_state, after_state, ip_address, created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, NOW()
    )
  `;

  const values = [
    entry.userId || null,
    entry.action,
    entry.entity,
    String(entry.entityId),
    sanitizedBefore,
    sanitizedAfter,
    validatedIp
  ];

  if (entry.client) {
    await entry.client.query(query, values);
  } else {
    await pool.query(query, values);
  }
}

/**
 * Convenience helper to log audit within an existing database transaction client
 */
export async function logAuditWithClient(client: PoolClient, entry: Omit<AuditLogEntry, 'client'>): Promise<void> {
  return logAudit({ ...entry, client });
}
