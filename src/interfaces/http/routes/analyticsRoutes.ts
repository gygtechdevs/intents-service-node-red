import { Router, type RequestHandler } from 'express';
import type { AnalyticsController } from '../controllers/AnalyticsController';

export interface AnalyticsRouteGuards {
  authenticate: RequestHandler;
  internalSecret: RequestHandler;
}

export function createAnalyticsRoutes(controller: AnalyticsController, guards: AnalyticsRouteGuards): Router {
  const router = Router();

  // Service-to-service ingest (X-Internal-Secret), written by the gateway.
  router.post('/internal/events', guards.internalSecret, controller.ingest);

  // Read-only aggregates: any valid JWT (same bar as GET /intents).
  router.get('/analytics/summary', guards.authenticate, controller.summary);
  router.get('/analytics/by-channel', guards.authenticate, controller.byChannel);
  router.get('/analytics/top-tags', guards.authenticate, controller.topTags);
  router.get('/analytics/daily', guards.authenticate, controller.daily);
  router.get('/analytics/top-intents', guards.authenticate, controller.topIntents);

  return router;
}
