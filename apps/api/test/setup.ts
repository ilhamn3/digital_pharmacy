import dotenv from 'dotenv';
import path from 'path';

// Load base .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Default test environment database to dedicated pharmacy_test if not explicitly defined
if (!process.env.DATABASE_URL || (!process.env.DATABASE_URL.endsWith('_test') && !process.env.DATABASE_URL.includes('/pharmacy_test'))) {
  const host = process.env.DB_HOST || 'localhost';
  const port = process.env.DB_PORT || '5433';
  const user = process.env.DB_USER || 'pharmacy_app';
  const pass = process.env.DB_PASSWORD || process.env.APP_DB_PASSWORD || 'pharmacy_app_pass';
  process.env.DATABASE_URL = `postgres://${user}:${pass}@${host}:${port}/pharmacy_test`;
}

// Strict requirement: Never run tests against dev or production DB; must end with _test
const cleanDbUrl = process.env.DATABASE_URL.split('?')[0];
if (!cleanDbUrl.endsWith('_test')) {
  throw new Error(
    `[TEST DATABASE ISOLATION ERROR] Refusing to run tests: DATABASE_URL must end with '_test' to protect the development database. Current: '${cleanDbUrl}'.`
  );
}

process.env.NODE_ENV = 'test';
