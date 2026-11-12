import { Pool } from 'pg';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/pharmacy_pos';
const pool = new Pool({ connectionString });

function parseArgs() {
  const args = process.argv.slice(2);
  let username = '';
  let email = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--username' && args[i + 1]) {
      username = args[i + 1];
      i++;
    } else if (args[i] === '--email' && args[i + 1]) {
      email = args[i + 1];
      i++;
    }
  }

  // Fallback to positional arguments if flags not provided
  if (!username && args[0] && !args[0].startsWith('--')) username = args[0];
  if (!email && args[1] && !args[1].startsWith('--')) email = args[1];

  return { username, email };
}

function generateSecurePassword(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';
  const bytes = crypto.randomBytes(length);
  let pass = '';
  for (let i = 0; i < length; i++) {
    pass += chars[bytes[i] % chars.length];
  }
  return pass;
}

async function bootstrapOwner() {
  const { username, email } = parseArgs();

  if (!username || !email) {
    console.error('❌ Error: Both username and email are required to bootstrap an owner account.');
    console.log('Usage: npm run bootstrap:owner -- --username <username> --email <email>');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const rawPassword = generateSecurePassword(16);
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const res = await client.query(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, 'owner', true, true)
       ON CONFLICT (username) DO UPDATE 
       SET email = EXCLUDED.email, password_hash = EXCLUDED.password_hash, role = 'owner', must_change_password = true, updated_at = NOW()
       RETURNING id, username, email`,
      [username, email, passwordHash, username]
    );

    const user = res.rows[0];

    console.log('\n================================================================');
    console.log('👑 PHARMACY OWNER ACCOUNT BOOTSTRAPPED SUCCESSFULLY');
    console.log('================================================================');
    console.log(`User ID:              ${user.id}`);
    console.log(`Username:             ${user.username}`);
    console.log(`Email:                ${user.email}`);
    console.log(`Role:                 owner`);
    console.log(`Temporary Password:   ${rawPassword}`);
    console.log('----------------------------------------------------------------');
    console.log('⚠️  IMPORTANT: Store this password securely. It will NEVER be shown again.');
    console.log('   The user is marked must_change_password = true and must change it on first login.');
    console.log('================================================================\n');
  } catch (error) {
    console.error('❌ Failed to bootstrap owner account:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

bootstrapOwner();

