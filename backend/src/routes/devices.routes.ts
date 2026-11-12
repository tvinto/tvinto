import { Router } from 'express';
import {
  getSettings,
  pullChanges,
  pushChanges,
  saveSettings
} from '../controllers/devices.controller';
import { requireAccount } from '../middleware/requireSession';

const router = Router();

// requireAccount rather than requireSession: reconciling what you have made
// does not need a working subscription, and a device whose credentials have
// just expired is exactly one that should still be able to sync.
router.use(requireAccount);

router.get('/changes', pullChanges);
router.post('/changes', pushChanges);

router.get('/settings', getSettings);
router.post('/settings', saveSettings);

export default router;
