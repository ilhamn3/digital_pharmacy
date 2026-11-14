import { Client } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function setupAppRole() {
  const connectionString = process.env.MIGRATION_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
  const appPassword = process.env.APP_DB_PASSWORD || 'pharmacy_app_pass';

  console.log('🔒 Configuring pharmacy_app role login and credentials...');
  const client = new Client({ connectionString });

  try {
    await client.connect();

    // Set LOGIN and password for pharmacy_app
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'pharmacy_app') THEN
          EXECUTE format('ALTER ROLE pharmacy_app WITH LOGIN PASSWORD %L', '${appPassword}');
        END IF;
      END $$;
    `);

    console.log('✅ pharmacy_app role successfully configured with LOGIN permission.');
  } catch (error) {
    console.error('❌ Failed to configure pharmacy_app role:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  setupAppRole();
}

