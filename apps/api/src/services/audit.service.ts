import { PoolClient } from 'pg';
import { pool } from '../db/pool.js';

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

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'oldpassword',
  'newpassword',
  'confirmpassword',
  'token',
  'refreshtoken',
  'rawtoken',
  'secret',
  'jwt_access_secret',
  'jwt_refresh_secret'
]);

/**
 * Deeply sanitizes an object to ensure no passwords or secrets are ever recorded in audit trails.
 */
export function sanitizeForAudit(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForAudit);
  }

  const sanitized: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitizeForAudit(val);
    } else {
      sanitized[key] = val;
    }
  }

  return sanitized;
}

/**
 * Persists an immutable audit log row.
 */
export async function logAudit(entry: AuditLogEntry): Promise<void> {
  const sanitizedBefore = entry.beforeState !== undefined ? JSON.stringify(sanitizeForAudit(entry.beforeState)) : null;
  const sanitizedAfter = entry.afterState !== undefined ? JSON.stringify(sanitizeForAudit(entry.afterState)) : null;

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
    entry.ipAddress || null
  ];

  if (entry.client) {
    await entry.client.query(query, values);
  } else {
    await pool.query(query, values);
  }
}

