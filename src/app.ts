import express, { type Express } from 'express';
import { CreateIntentUseCase } from './application/use-cases/CreateIntentUseCase';
import { DeleteIntentUseCase } from './application/use-cases/DeleteIntentUseCase';
import { DetectIntentUseCase } from './application/use-cases/DetectIntentUseCase';
import { ListIntentsUseCase } from './application/use-cases/ListIntentsUseCase';
import { UpdateIntentUseCase } from './application/use-cases/UpdateIntentUseCase';
import { AnalyticsUseCases } from './application/use-cases/AnalyticsUseCases';
import { RecordEventsUseCase } from './application/use-cases/RecordEventsUseCase';
import { ApproveUnmatchedUseCase } from './application/use-cases/ApproveUnmatchedUseCase';
import { ListUnmatchedUseCase } from './application/use-cases/ListUnmatchedUseCase';
import { RejectUnmatchedUseCase } from './application/use-cases/RejectUnmatchedUseCase';
import { KeywordIntentClassifier } from './application/services/KeywordIntentClassifier';
import type { IntentExamplesSync } from './application/services/IntentExamplesSync';
import type { MissRecorder } from './application/services/UnmatchedRecorder';
import type { Embedder } from './domain/ports/Embedder';
import type { IntentClassifier } from './domain/ports/IntentClassifier';
import type { IntentExampleRepository } from './domain/repositories/IntentExampleRepository';
import type { IntentRepository } from './domain/repositories/IntentRepository';
import type { MessageEventRepository } from './domain/repositories/MessageEventRepository';
import type { UnmatchedMessageRepository } from './domain/repositories/UnmatchedMessageRepository';
import { CachingEmbedder } from './application/services/CachingEmbedder';
import { BulkReviewUnmatchedUseCase } from './application/use-cases/BulkReviewUnmatchedUseCase';
import { ClusterUnmatchedUseCase } from './application/use-cases/ClusterUnmatchedUseCase';
import { SimulateImpactUseCase } from './application/use-cases/SimulateImpactUseCase';
import { ClustersController } from './interfaces/http/controllers/ClustersController';
import { UnmatchedController, type Reembedder } from './interfaces/http/controllers/UnmatchedController';
import { createAdminRoutes } from './interfaces/http/routes/adminRoutes';
import { AnalyticsController } from './interfaces/http/controllers/AnalyticsController';
import { createAnalyticsRoutes } from './interfaces/http/routes/analyticsRoutes';
import { IntentsController } from './interfaces/http/controllers/IntentsController';
import { createAuthMiddleware, requirePermission } from './interfaces/http/middlewares/authMiddleware';
import { errorHandler } from './interfaces/http/middlewares/errorHandler';
import { createInternalSecretMiddleware } from './interfaces/http/middlewares/internalSecretMiddleware';
import { applySecurityHeaders, loadSecurityConfig, type SecurityConfig } from './interfaces/http/security';
import { createIntentsRoutes } from './interfaces/http/routes/intentsRoutes';

export interface AppConfig {
  jwtSecret: string;
  internalSecret: string;
}

/** What approving a message as an example needs; only available when semantic matching is enabled. */
export interface UnmatchedReviewDependencies {
  examples: Pick<IntentExampleRepository, 'upsertMany' | 'searchSimilar' | 'listEmbedded'>;
  embedder: Embedder;
  embedModelId: string;
  /** Thresholds the live classifier uses; impact simulation applies the same rule. Defaults: 0.8 / 0.05 / 5. */
  matching?: { minSimilarity: number; ambiguityMargin: number; topK: number };
  /** Embeds examples whose embedding is still NULL (POST /admin/intent-examples/reembed). */
  reembed: Reembedder;
}

export interface AppDependencies {
  repository: IntentRepository;
  config: AppConfig;
  /** Defaults to the CORS_ALLOWED_ORIGINS env var. */
  security?: SecurityConfig;
  /** Message-event store. When omitted the analytics endpoints are not mounted. */
  events?: MessageEventRepository;
  /** Clock, injectable for tests. */
  now?: () => Date;
  /** Intent classifier. Defaults to keyword-only matching. */
  classifier?: IntentClassifier;
  /** Sink for unmatched messages (fire-and-forget). When omitted nothing is captured. */
  unmatchedRecorder?: MissRecorder;
  /** Keeps semantic examples in step with keyword/description changes (background). Absent = no sync. */
  examplesSync?: IntentExamplesSync;
  /** Store of unmatched messages. When present the /admin/unmatched review endpoints are mounted. */
  unmatched?: UnmatchedMessageRepository;
  /** Enables approve / approve-new / reembed. Without it those endpoints answer 503. */
  unmatchedReview?: UnmatchedReviewDependencies;
}

/** Composition root. Takes its adapters so tests can run without a database. */
export function createApp({
  repository,
  config,
  security,
  events,
  now = () => new Date(),
  classifier = new KeywordIntentClassifier(),
  unmatchedRecorder,
  examplesSync,
  unmatched,
  unmatchedReview,
}: AppDependencies): Express {
  const app = express();
  applySecurityHeaders(app, security ?? loadSecurityConfig());
  app.use(express.json({ limit: '1mb' }));

  const createIntent = new CreateIntentUseCase(repository, examplesSync);
  const controller = new IntentsController(
    new ListIntentsUseCase(repository),
    createIntent,
    new UpdateIntentUseCase(repository, examplesSync),
    new DeleteIntentUseCase(repository),
    new DetectIntentUseCase(repository, classifier, unmatchedRecorder),
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.use(
    createIntentsRoutes(controller, {
      authenticate: createAuthMiddleware(config.jwtSecret),
      requireWrite: requirePermission('WRITE', 'ADMIN'),
      requireAdmin: requirePermission('ADMIN'),
      internalSecret: createInternalSecretMiddleware(config.internalSecret),
    }),
  );

  if (events) {
    app.use(
      createAnalyticsRoutes(
        new AnalyticsController(new RecordEventsUseCase(events, now), new AnalyticsUseCases(events, now)),
        {
          authenticate: createAuthMiddleware(config.jwtSecret),
          internalSecret: createInternalSecretMiddleware(config.internalSecret),
        },
      ),
    );
  }

  if (unmatched) {
    const approve = unmatchedReview
      ? new ApproveUnmatchedUseCase({
          unmatched,
          intents: repository,
          createIntent,
          examples: unmatchedReview.examples,
          embedder: unmatchedReview.embedder,
          embedModelId: unmatchedReview.embedModelId,
        })
      : undefined;
    const reject = new RejectUnmatchedUseCase(unmatched);
    // Embeddings are cached so clustering and simulation do not re-embed the same messages.
    const embedder = unmatchedReview ? new CachingEmbedder(unmatchedReview.embedder) : undefined;
    const clusters = new ClustersController(
      new ClusterUnmatchedUseCase({
        unmatched,
        intents: repository,
        ...(unmatchedReview && embedder ? { examples: unmatchedReview.examples, embedder } : {}),
      }),
      new BulkReviewUnmatchedUseCase(approve, reject),
      unmatchedReview && embedder
        ? new SimulateImpactUseCase({
            unmatched,
            intents: repository,
            examples: unmatchedReview.examples,
            embedder,
            options: unmatchedReview.matching ?? { minSimilarity: 0.8, ambiguityMargin: 0.05, topK: 5 },
            now,
          })
        : undefined,
    );
    app.use(
      createAdminRoutes(
        new UnmatchedController(new ListUnmatchedUseCase(unmatched), reject, approve, unmatchedReview?.reembed),
        { authenticate: createAuthMiddleware(config.jwtSecret), requireAdmin: requirePermission('ADMIN') },
        clusters,
      ),
    );
  }

  app.use(errorHandler);

  return app;
}
