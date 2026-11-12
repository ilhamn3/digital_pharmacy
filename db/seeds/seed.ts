import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { seedReference } from './reference.js';
import { seedDemo } from './demo.js';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run seed script in production!');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
const pool = new Pool({ connectionString });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedReference(client);
    await seedDemo(client);
    await client.query('COMMIT');
    console.log('\n🎉 Complete database seed finished successfully!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
