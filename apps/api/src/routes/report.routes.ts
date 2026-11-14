import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth.js';
import { requireRoles } from '../middleware/rbac.js';
import { AuthenticatedRequest } from '../types/auth.js';

const router = Router();

// Reports are strictly restricted to Owner and Pharmacist (Cashier gets 403 Forbidden)
router.use(authenticate, requireRoles('owner', 'pharmacist'));

router.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  return res.json({
    status: 'ok',
    message: 'Reports module is scheduled for Phase 2'
  });
});

export { router as reportRouter };
