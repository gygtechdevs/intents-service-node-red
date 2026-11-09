import { Router, type RequestHandler } from 'express';
import type { IntentsController } from '../controllers/IntentsController';

export interface IntentsRouteGuards {
  authenticate: RequestHandler;
  requireWrite: RequestHandler;
  requireAdmin: RequestHandler;
  internalSecret: RequestHandler;
}

export function createIntentsRoutes(controller: IntentsController, guards: IntentsRouteGuards): Router {
  const router = Router();

  // Service-to-service (X-Internal-Secret). `/intents/detect` is declared before
  // `/intents/:name` so the static segment wins.
  router.post('/intents/detect', guards.internalSecret, controller.detect);
  router.get('/internal/intents', guards.internalSecret, controller.list);

  // Catalog CRUD (JWT).
  router.get('/intents', guards.authenticate, controller.list);
  router.post('/intents', guards.authenticate, guards.requireWrite, controller.create);
  router.put('/intents/:name', guards.authenticate, guards.requireWrite, controller.update);
  router.delete('/intents/:name', guards.authenticate, guards.requireAdmin, controller.remove);

  return router;
}
