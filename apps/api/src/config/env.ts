import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().transform((val) => parseInt(val, 10)).default('4000'),
  CLIENT_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5433/pharmacy_pos'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters long'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters long'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY_DAYS: z.string().transform((val) => parseInt(val, 10)).default('7'),
  TIMEZONE: z.string().default('Asia/Colombo'),
  CURRENCY: z.string().default('LKR')
});

export const env = envSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL,
  DATABASE_URL: process.env.DATABASE_URL,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'pharmacy_dev_access_secret_key_minimum_32_characters_long_for_security',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || 'pharmacy_dev_refresh_secret_key_minimum_32_characters_long_for_security',
  JWT_ACCESS_EXPIRY: process.env.JWT_ACCESS_EXPIRY || '15m',
  JWT_REFRESH_EXPIRY_DAYS: process.env.JWT_REFRESH_EXPIRY_DAYS || '7',
  TIMEZONE: process.env.TIMEZONE || 'Asia/Colombo',
  CURRENCY: process.env.CURRENCY || 'LKR'
});

