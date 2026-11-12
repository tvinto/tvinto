import express, { Express } from 'express';
import routes from '../routes';

/**
 * The API mounted for tests.
 *
 * Assembled from the router rather than app.ts so no server listens and no
 * background scheduler starts; the routing, the session middleware and the
 * controllers are the real ones.
 */
export function createTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return app;
}
