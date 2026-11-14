import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { pool } from './db/pool.js';
import { cashierDataSanitizer } from './middleware/rbac.js';
import { authRouter } from './routes/auth.routes.js';
import { userRouter } from './routes/user.routes.js';
import { auditRouter } from './routes/audit.routes.js';
import { productRouter } from './routes/product.routes.js';
import { supplierRouter } from './routes/supplier.routes.js';
import { customerRouter } from './routes/customer.routes.js';
import { purchaseRouter } from './routes/purchase.routes.js';
import { stockRouter } from './routes/stock.routes.js';
import { reportRouter } from './routes/report.routes.js';
import { settingsRouter } from './routes/settings.routes.js';
import { saleRouter } from './routes/sale.routes.js';
import { holdBillRouter } from './routes/hold-bill.routes.js';
import { authenticate } from './middleware/auth.js';
import { assertAppRoleSecurity } from './db/pool.js';

const app = express();
const port = env.PORT || 4000;

// Trust proxy only when configured via TRUST_PROXY env variable
if (process.env.TRUST_PROXY) {
  const tpVal = process.env.TRUST_PROXY;
  app.set('trust proxy', tpVal === 'true' ? true : (!isNaN(Number(tpVal)) ? Number(tpVal) : tpVal));
} else {
  app.set('trust proxy', false);
}

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false
}));

app.use(cors({
  origin: env.CLIENT_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(cookieParser());
app.use(express.json());

// Global cost price sanitizer for cashier role
app.use(cashierDataSanitizer);

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    const dbRes = await pool.query('SELECT NOW() as current_time, 1 as status');
    return res.json({
      status: 'healthy',
      service: 'pharmacy-pos-api',
      timestamp: new Date().toISOString(),
      database: 'connected',
      timezone: env.TIMEZONE,
      currency: env.CURRENCY,
      db_time: dbRes.rows[0].current_time
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      service: 'pharmacy-pos-api',
      database: 'disconnected',
      error: (error as Error).message
    });
  }
});

// Mount Routes
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/audit-logs', auditRouter);
app.use('/api/v1/products', productRouter);
app.use('/api/v1/suppliers', supplierRouter);
app.use('/api/v1/customers', customerRouter);
app.use('/api/v1/purchases', purchaseRouter);
app.use('/api/v1/stock', stockRouter);
app.use('/api/v1/reports', reportRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/sales', saleRouter);
app.use('/api/v1/hold-bills', holdBillRouter);

// Test endpoint for role-based data masking verification
app.get('/api/v1/test/price-visibility', authenticate, async (_req, res) => {
  // Returns payload containing cost prices
  return res.json({
    product: 'Panadol 500mg',
    batch_no: 'B-PAN-01',
    mrp: '4.00',
    cost_price: '2.50',
    batches: [
      { id: '1', batch_no: 'B-01', unit_cost_price: '2.50', unit_selling_price: '4.00' }
    ]
  });
});

if (env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`🚀 Pharmacy POS API server running on port ${port} [Timezone: ${env.TIMEZONE}]`);
  });
}

export { app };
