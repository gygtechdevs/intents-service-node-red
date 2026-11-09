import { UnmatchedRecorder } from './application/services/UnmatchedRecorder';
import { startUnmatchedPurge } from './application/services/UnmatchedPurgeScheduler';
import { PurgeUnmatchedUseCase } from './application/use-cases/PurgeUnmatchedUseCase';
import { createApp } from './app';
import { env } from './infrastructure/config/env';
import { assertSchema, createPool } from './infrastructure/db/pool';
import { CachedIntentRepository } from './infrastructure/repositories/CachedIntentRepository';
import { PgIntentRepository } from './infrastructure/repositories/PgIntentRepository';
import { PgUnmatchedMessageRepository } from './infrastructure/repositories/PgUnmatchedMessageRepository';
import { PgMessageEventRepository } from './infrastructure/repositories/PgMessageEventRepository';
import { createSemanticServices } from './infrastructure/semantic/createSemanticServices';

const bootstrap = async (): Promise<void> => {
  const pool = createPool(env.databaseUrl, env.pgSsl);
  await assertSchema(pool, { semanticEnabled: env.semanticEnabled });

  const intents = new CachedIntentRepository(new PgIntentRepository(pool), { ttlMs: env.catalogCacheTtlMs });
  // null when SEMANTIC_ENABLED=false (keyword-only); throws if enabled without AWS_REGION.
  const semantic = createSemanticServices({ config: env, pool, intents });

  // Same store for capture, review and retention; only exists when capture is opted in.
  const unmatched = env.unmatchedCaptureEnabled ? new PgUnmatchedMessageRepository(pool) : undefined;

  const app = createApp({
    repository: intents,
    events: new PgMessageEventRepository(pool),
    ...(unmatched
      ? {
          unmatched,
          unmatchedRecorder: new UnmatchedRecorder(unmatched, { maxLength: env.unmatchedMaxLength }),
        }
      : {}),
    ...(semantic
      ? { classifier: semantic.classifier, examplesSync: semantic.examplesSync, unmatchedReview: semantic.review }
      : {}),
    config: { jwtSecret: env.jwtSecret, internalSecret: env.internalSecret },
  });

  // Retention: daily, batched, idempotent; nothing is stored (so nothing to purge) when capture is off.
  if (unmatched) {
    startUnmatchedPurge(new PurgeUnmatchedUseCase(unmatched, { retentionDays: env.unmatchedRetentionDays }));
  }

  app.listen(env.port, () => {
    console.log(`Intents service running on port ${env.port}${semantic ? ' (semantic detection enabled)' : ''}`);
  });
};

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
