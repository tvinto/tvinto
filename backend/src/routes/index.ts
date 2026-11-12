import { Router } from 'express';
import accountsRoutes from './accounts.routes';
import devicesRoutes from './devices.routes';
import streamsRoutes from './streams.routes';
import syncRoutes from './sync.routes';

const router = Router();

// Health check endpoint
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API routes
router.use('/api/accounts', accountsRoutes);
router.use('/api/devices', devicesRoutes);
router.use('/api/streams', streamsRoutes);
router.use('/api/sync', syncRoutes);

// The stream routes were once mounted at /api as well as /api/streams. Nothing
// calls them that way, and the mount ended with a catch-all, so every unknown
// path under /api reached it and came back 401 -- telling a caller to
// authenticate for an endpoint that does not exist.

// 404 handler
router.use((_req, res) => {
  res.status(404).json({
    success: false,
    message: 'Not Found',
    timestamp: new Date().toISOString(),
  });
});

export default router;
