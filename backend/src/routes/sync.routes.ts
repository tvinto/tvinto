import { Router } from 'express';
import { syncData, getSyncStatus, cancelSync } from '../controllers/sync.controller';
import { requireSession } from '../middleware/requireSession';

const router = Router();

router.use(requireSession);

router.post('/', syncData);
router.get('/status/:type', getSyncStatus);
router.post('/cancel', cancelSync);

export default router;
