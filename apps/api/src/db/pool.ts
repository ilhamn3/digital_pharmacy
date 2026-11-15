import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://pharmacy_app:pharmacy_app_pass@localhost:5433/pharmacy_pos',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', (client) => {
  client.query("SET timezone TO 'Asia/Colombo'");
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Startup security assertion:
 * Refuses to boot in production if the database connection role is a superuser or table owner.
 */
export async function assertAppRoleSecurity(dbPool: Pool = pool): Promise<{
  currentUser: string;
  isSuperuser: boolean;
  isTableOwner: boolean;
}> {
  const res = await dbPool.query(`
    SELECT 
      current_user AS db_user,
      COALESCE((SELECT usesuper FROM pg_user WHERE usename = current_user), false) AS is_superuser,
      EXISTS (
        SELECT 1 FROM pg_tables 
        WHERE schemaname = 'public' AND tableowner = current_user
      ) AS is_table_owner
  `);
  const row = res.rows[0];
  const isSuperuser = Boolean(row?.is_superuser);
  const isTableOwner = Boolean(row?.is_table_owner);
  const currentUser = String(row?.db_user || '');

  if (isSuperuser || isTableOwner) {
    const errorMsg = `Security Violation: API database connection role '${currentUser}' must not be a superuser or table owner. Connected role has is_superuser=${isSuperuser}, is_table_owner=${isTableOwner}. Connect as 'pharmacy_app'.`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(errorMsg);
    } else {
      console.warn(`[SECURITY WARNING] ${errorMsg}`);
    }
  }

  // Production security: refuse to boot if using default password from .env.example
  const dbUrl = process.env.DATABASE_URL || '';
  const appPass = process.env.APP_DB_PASSWORD || '';
  const isDefaultPassword = appPass === 'pharmacy_app_pass' || dbUrl.includes(':pharmacy_app_pass@');

  if (process.env.NODE_ENV === 'test') {
    const cleanUrl = dbUrl.split('?')[0];
    if (!cleanUrl.endsWith('_test')) {
      throw new Error(`[SECURITY] Refusing to run in test mode: DATABASE_URL must end with '_test'. Received: '${cleanUrl}'`);
    }
  }

  if (isDefaultPassword) {
    const passError = `Security Violation: Production database password must not use the default password from .env.example ('pharmacy_app_pass'). Please configure a strong, unique APP_DB_PASSWORD.`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(passError);
    } else {
      console.warn(`[SECURITY WARNING] ${passError}`);
    }
  }

  return { currentUser, isSuperuser, isTableOwner };
}


