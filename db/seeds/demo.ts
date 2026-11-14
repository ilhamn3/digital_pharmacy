import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

if (process.env.NODE_ENV === 'production') {
  console.error('❌ Refusing to run demo seed script in production!');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
const pool = new Pool({ connectionString });

export async function seedDemo(client?: any) {
  const ownClient = !client;
  const db = client || (await pool.connect());

  try {
    if (ownClient) await db.query('BEGIN');
    console.log('🌱 Seeding Demo Data (Users, Suppliers, Customers, Inventory & Movements)...');

    // 1. Seed demo users (owner, pharmacist, cashier)
    const passwordHash = await bcrypt.hash('password123', 10);
    const users = [
      {
        username: 'admin',
        email: 'owner@lankahealth.lk',
        password_hash: passwordHash,
        full_name: 'Dr. Rohan Jayasuriya',
        role: 'owner',
        must_change_password: false
      },
      {
        username: 'pharmacist',
        email: 'pharmacist@lankahealth.lk',
        password_hash: passwordHash,
        full_name: 'Nimali Senanayake (B.Pharm)',
        role: 'pharmacist',
        must_change_password: false
      },
      {
        username: 'cashier',
        email: 'cashier@lankahealth.lk',
        password_hash: passwordHash,
        full_name: 'Kasun Wickramasinghe',
        role: 'cashier',
        must_change_password: false
      }
    ];

    const userMap: Record<string, string> = {};
    for (const u of users) {
      const res = await db.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active, must_change_password)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         ON CONFLICT (username) DO UPDATE 
         SET full_name = EXCLUDED.full_name, role = EXCLUDED.role, updated_at = NOW()
         RETURNING id, username`,
        [u.username, u.email, u.password_hash, u.full_name, u.role, u.must_change_password]
      );
      userMap[u.username] = res.rows[0].id;
    }
    const adminId = userMap['admin'];

    // 2. Seed demo suppliers
    const suppliers = [
      {
        name: 'State Pharmaceuticals Manufacturing Corporation (SPMC)',
        phone: '+94 11 285 5312',
        address: 'No. 11, Sir John Kotelawala Mawatha, Ratmalana, Sri Lanka'
      },
      {
        name: 'George Steuart Health (Pvt) Ltd',
        phone: '+94 11 472 8800',
        address: 'No. 7, St. Michael\'s Road, Colombo 03, Sri Lanka'
      },
      {
        name: 'Hemas Pharmaceuticals (Pvt) Ltd',
        phone: '+94 11 473 1731',
        address: 'Hemas House, No. 75, Braybrooke Place, Colombo 02, Sri Lanka'
      }
    ];

    const supplierIds: string[] = [];
    for (const sup of suppliers) {
      const res = await db.query(
        `INSERT INTO suppliers (name, phone, address, outstanding_balance, is_active)
         VALUES ($1, $2, $3, 0.00, true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [sup.name, sup.phone, sup.address]
      );
      if (res.rows.length > 0) {
        supplierIds.push(res.rows[0].id);
      } else {
        const existing = await db.query('SELECT id FROM suppliers WHERE name = $1', [sup.name]);
        if (existing.rows.length > 0) supplierIds.push(existing.rows[0].id);
      }
    }
    const defaultSupplierId = supplierIds[0] || null;

    // 3. Seed demo credit customers
    const customers = [
      {
        name: 'Sunil Perera',
        phone: '+94 77 123 4567',
        credit_limit: '15000.00',
        credit_balance: '0.00'
      },
      {
        name: 'Kamala Fernando',
        phone: '+94 71 987 6543',
        credit_limit: '5000.00',
        credit_balance: '0.00'
      }
    ];

    for (const c of customers) {
      await db.query(
        `INSERT INTO customers (name, phone, credit_balance, credit_limit, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (phone) DO UPDATE 
         SET credit_limit = EXCLUDED.credit_limit, updated_at = NOW()`,
        [c.name, c.phone, c.credit_balance, c.credit_limit]
      );
    }

    // 4. Products & Batches
    const now = new Date();
    const addDays = (d: number) => {
      const date = new Date(now.getTime() + d * 86400000);
      return date.toISOString().split('T')[0];
    };

    const demoCatalog = [
      {
        name: 'Panadol 500mg',
        generic_name: 'Paracetamol',
        barcode: '8901234567890',
        category: 'Analgesics',
        unit: 'tablet',
        pack_size: 10,
        is_rx_required: false,
        reorder_level: 100,
        batches: [
          // Expired batch
          {
            batch_no: 'B-PAN-EXPIRED-01',
            expiry_date: addDays(-30),
            cost_price: '2.50',
            mrp: '4.00',
            initial_qty: '50.00'
          },
          // Zero-qty batch with nearest expiry
          {
            batch_no: 'B-PAN-ZEROQTY-01',
            expiry_date: addDays(5),
            cost_price: '2.50',
            mrp: '4.00',
            initial_qty: '0.00'
          },
          // Active batches
          {
            batch_no: 'B-PAN-2024-01',
            expiry_date: addDays(180),
            cost_price: '2.50',
            mrp: '4.00',
            initial_qty: '500.00'
          },
          {
            batch_no: 'B-PAN-2024-02',
            expiry_date: addDays(360),
            cost_price: '2.70',
            mrp: '4.50',
            initial_qty: '1000.00'
          }
        ]
      },
      {
        name: 'Amoxicillin 250mg DT',
        generic_name: 'Amoxicillin Trihydrate Dispersible',
        barcode: '8901234567891',
        category: 'Antibiotics',
        unit: 'tablet',
        pack_size: 10,
        is_rx_required: true,
        reorder_level: 30,
        batches: [
          // 3 small batches for FEFO split testing
          {
            batch_no: 'B-AMX250-EXP30',
            expiry_date: addDays(30),
            cost_price: '10.00',
            mrp: '16.00',
            initial_qty: '10.00'
          },
          {
            batch_no: 'B-AMX250-EXP60',
            expiry_date: addDays(60),
            cost_price: '10.00',
            mrp: '16.00',
            initial_qty: '15.00'
          },
          {
            batch_no: 'B-AMX250-EXP90',
            expiry_date: addDays(90),
            cost_price: '10.00',
            mrp: '16.00',
            initial_qty: '25.00'
          }
        ]
      },
      {
        name: 'Omep 20mg',
        generic_name: 'Omeprazole',
        barcode: '8901234567892',
        category: 'Gastrointestinal',
        unit: 'capsule',
        pack_size: 14,
        is_rx_required: true,
        reorder_level: 40,
        batches: [
          {
            batch_no: 'B-OMP-2024-01',
            expiry_date: addDays(240),
            cost_price: '12.00',
            mrp: '20.00',
            initial_qty: '400.00'
          }
        ]
      },
      {
        name: 'Glucophage 500mg',
        generic_name: 'Metformin Hydrochloride',
        barcode: '8901234567893',
        category: 'Antidiabetic',
        unit: 'tablet',
        pack_size: 10,
        is_rx_required: true,
        reorder_level: 100,
        batches: [
          {
            batch_no: 'B-MET-2024-01',
            expiry_date: addDays(365),
            cost_price: '5.20',
            mrp: '8.50',
            initial_qty: '800.00'
          }
        ]
      },
      {
        name: 'Ventolin Inhaler 100mcg',
        generic_name: 'Salbutamol Sulfate',
        barcode: '8901234567896',
        category: 'Respiratory',
        unit: 'inhaler',
        pack_size: 1,
        is_rx_required: true,
        reorder_level: 15,
        batches: [
          {
            batch_no: 'B-SAL-2024-01',
            expiry_date: addDays(450),
            cost_price: '680.00',
            mrp: '950.00',
            initial_qty: '30.00'
          }
        ]
      }
    ];

    for (const p of demoCatalog) {
      const prodRes = await db.query(
        `INSERT INTO products (name, generic_name, barcode, category, unit, pack_size, is_rx_required, reorder_level, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (barcode) DO UPDATE 
         SET name = EXCLUDED.name, generic_name = EXCLUDED.generic_name, pack_size = EXCLUDED.pack_size, updated_at = NOW()
         RETURNING id`,
        [p.name, p.generic_name, p.barcode, p.category, p.unit, p.pack_size, p.is_rx_required, p.reorder_level]
      );
      const productId = prodRes.rows[0].id;

      for (const b of p.batches) {
        const existingBatch = await db.query(
          `SELECT id FROM batches WHERE product_id = $1 AND batch_no = $2`,
          [productId, b.batch_no]
        );

        if (existingBatch.rows.length === 0) {
          // Batch starts at 0.00 current_quantity!
          const batchRes = await db.query(
            `INSERT INTO batches (
               product_id, supplier_id, batch_no, expiry_date, cost_price, mrp, initial_quantity, current_quantity, is_active
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, 0.00, true)
             RETURNING id`,
            [productId, defaultSupplierId, b.batch_no, b.expiry_date, b.cost_price, b.mrp, b.initial_qty]
          );
          const batchId = batchRes.rows[0].id;

          // Inserting into stock_movements activates trg_stock_movements_apply which updates batches.current_quantity
          if (parseFloat(b.initial_qty) > 0) {
            await db.query(
              `INSERT INTO stock_movements (
                 batch_id, movement_type, qty_change, ref_type, ref_id, created_by, created_at
               )
               VALUES ($1, 'opening_stock', $2, 'opening_stock', $3, $4, NOW())`,
              [batchId, b.initial_qty, batchId, adminId]
            );
          }
        }
      }
    }

    if (ownClient) await db.query('COMMIT');
    console.log('✅ Demo seed completed successfully with verified opening stock movements.');
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
  seedDemo().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
