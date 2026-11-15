import { Client, Pool } from 'pg';
import runner from 'node-pg-migrate';
import dotenv from 'dotenv';
import path from 'path';
import { seedReference } from '../seeds/reference.js';
import { seedDemo } from '../seeds/demo.js';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const TEST_DB_NAME = 'pharmacy_test';

// Admin connection to create/drop the test database
const adminUrl = process.env.MIGRATION_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
const parsedUrl = new URL(adminUrl);
parsedUrl.pathname = '/postgres';
const adminPostgresUrl = parsedUrl.toString();

// Target test database URLs
parsedUrl.pathname = `/${TEST_DB_NAME}`;
const testMigrationDbUrl = parsedUrl.toString();

const appPassword = process.env.APP_DB_PASSWORD || 'pharmacy_app_pass';
const testAppDbUrl = `postgres://pharmacy_app:${appPassword}@${parsedUrl.host}/${TEST_DB_NAME}`;

export async function resetTestDatabase() {
  console.log(`\n🔄 [TEST DB RESET] Resetting dedicated test database: ${TEST_DB_NAME}...`);

  const adminClient = new Client({ connectionString: adminPostgresUrl });
  await adminClient.connect();

  try {
    // 1. Terminate any existing connections to the test DB
    await adminClient.query(`
      SELECT pg_terminate_backend(pid) 
      FROM pg_stat_activity 
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [TEST_DB_NAME]);

    // 2. Drop and recreate test database
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
    await adminClient.query(`CREATE DATABASE ${TEST_DB_NAME} WITH OWNER postgres`);
    await adminClient.query(`ALTER DATABASE ${TEST_DB_NAME} SET timezone = 'Asia/Colombo'`);
    console.log(`✅ Database '${TEST_DB_NAME}' created with Asia/Colombo timezone.`);
  } finally {
    await adminClient.end();
  }

  // 3. Run all migrations against pharmacy_test
  console.log(`📦 Running migrations on '${TEST_DB_NAME}'...`);
  await runner({
    databaseUrl: testMigrationDbUrl,
    dir: path.resolve(__dirname, '../migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {} // Silent migration output
  });
  console.log(`✅ Migrations 001-008 applied cleanly.`);

  // 4. Configure pharmacy_app permissions on pharmacy_test
  const configClient = new Client({ connectionString: testMigrationDbUrl });
  await configClient.connect();
  try {
    await configClient.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pharmacy_app') THEN
          EXECUTE format('ALTER ROLE pharmacy_app WITH LOGIN PASSWORD %L', '${appPassword}');
        END IF;
      END $$;

      GRANT USAGE ON SCHEMA public TO pharmacy_app;
      GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO pharmacy_app;
      GRANT DELETE ON refresh_tokens, hold_bill_items TO pharmacy_app;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pharmacy_app;

      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO pharmacy_app;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pharmacy_app;
    `);
    console.log(`✅ Privileges granted to pharmacy_app on '${TEST_DB_NAME}'.`);
  } finally {
    await configClient.end();
  }

  // 5. Seed reference and demo data into pharmacy_test
  console.log(`🌱 Seeding reference and demo data into '${TEST_DB_NAME}'...`);
  const seedPool = new Pool({ connectionString: testMigrationDbUrl });
  const seedClient = await seedPool.connect();
  try {
    await seedClient.query('BEGIN');
    await seedReference(seedClient);
    await seedDemo(seedClient);
    await seedClient.query('COMMIT');
    console.log(`✅ Test database seeded with demo catalog, suppliers, batches, and users.`);
  } catch (err) {
    await seedClient.query('ROLLBACK');
    throw err;
  } finally {
    seedClient.release();
    await seedPool.end();
  }

  console.log(`🎉 [TEST DB RESET COMPLETE] Ready at: ${testAppDbUrl}\n`);
  return {
    testDbName: TEST_DB_NAME,
    testAppDbUrl,
    testMigrationDbUrl
  };
}

if (require.main === module || process.argv[1]?.endsWith('test-db-reset.ts')) {
  resetTestDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Failed to reset test database:', err);
      process.exit(1);
    });
}
