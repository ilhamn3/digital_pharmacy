import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run seed script in production!');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
const pool = new Pool({ connectionString });

export async function seedReference(client?: any) {
  const ownClient = !client;
  const db = client || (await pool.connect());

  try {
    if (ownClient) await db.query('BEGIN');
    console.log('🌱 Seeding Reference Data (Settings ONLY)...');

    // Reference data is strictly system settings & configuration
    const settings = [
      {
        key: 'shop_details',
        value: {
          name: 'Lanka Health Pharmacy',
          address: 'No. 42, Galle Road, Colombo 03, Sri Lanka',
          phone: '+94 11 234 5678',
          email: 'info@lankahealth.lk',
          registration_no: 'SL-PH-COL-2024-9981'
        },
        description: 'Primary pharmacy store profile and contact information'
      },
      {
        key: 'receipt_settings',
        value: {
          header: 'LANKA HEALTH PHARMACY',
          tagline: 'Trusted Healthcare & Wellness',
          footer: 'Thank you for your visit. Get well soon! Keep medicines out of reach of children.',
          show_generic_name: true,
          show_batch_no: true,
          print_copies: 1
        },
        description: '80mm thermal receipt header, footer, and display options'
      },
      {
        key: 'currency_settings',
        value: {
          currency: 'LKR',
          symbol: 'Rs.',
          decimal_places: 2
        },
        description: 'Currency configuration (Sri Lankan Rupee)'
      }
    ];

    for (const s of settings) {
      await db.query(
        `INSERT INTO settings (key, value, description, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [s.key, JSON.stringify(s.value), s.description]
      );
    }

    if (ownClient) await db.query('COMMIT');
    console.log('✅ Reference seed (settings only) completed successfully.');
  } catch (error) {
    if (ownClient) await db.query('ROLLBACK');
    throw error;
  } finally {
    if (ownClient) {
      db.release();
      await pool.end();
    }
  }
}

if (require.main === module) {
  seedReference().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
