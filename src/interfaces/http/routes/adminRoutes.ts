import { Router, type RequestHandler } from 'express';
import type { ClustersController } from '../controllers/ClustersController';
import type { UnmatchedController } from '../controllers/UnmatchedController';

export interface AdminRouteGuards {
  authenticate: RequestHandler;
  requireAdmin: RequestHandler;
}

/** Human-in-the-loop review of unmatched messages. Every route requires a valid JWT with ADMIN. */
export function createAdminRoutes(
  controller: UnmatchedController,
  guards: AdminRouteGuards,
  clusters?: ClustersController,
): Router {
  const router = Router();
  const admin = [guards.authenticate, guards.requireAdmin];

  // Registered before the `/:id/...` routes so "clusters" and "bulk" are never read as an id.
  if (clusters) {
    router.get('/admin/unmatched/clusters', ...admin, clusters.clusters);
    router.post('/admin/unmatched/clusters/simulate', ...admin, clusters.simulate);
    router.post('/admin/unmatched/bulk/approve', ...admin, clusters.bulkApprove);
    router.post('/admin/unmatched/bulk/reject', ...admin, clusters.bulkReject);
  }

  router.get('/admin/unmatched', ...admin, controller.list);
  router.post('/admin/unmatched/:id/approve', ...admin, controller.approve);
  router.post('/admin/unmatched/:id/approve-new', ...admin, controller.approveNew);
  router.post('/admin/unmatched/:id/reject', ...admin, controller.reject);
  router.post('/admin/intent-examples/reembed', ...admin, controller.reembed);

  return router;
}
