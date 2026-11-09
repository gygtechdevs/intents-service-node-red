/**
 * Backfill of semantic intent examples (idempotent; safe to re-run, also retries NULL embeddings).
 *
 *     npm run backfill:examples
 *
 * Needs DATABASE_URL, AWS_REGION (and AWS credentials from the default chain) and migration 005 applied.
 * Rollout order: migrate -> backfill -> SEMANTIC_ENABLED=true.
 */
import { env } from '../src/infrastructure/config/env';
import { assertSchema, createPool } from '../src/infrastructure/db/pool';
import { PgIntentRepository } from '../src/infrastructure/repositories/PgIntentRepository';
import { createSemanticServices } from '../src/infrastructure/semantic/createSemanticServices';

const main = async (): Promise<void> => {
  const pool = createPool(env.databaseUrl, env.pgSsl);
  try {
    await assertSchema(pool, { semanticEnabled: true });
    // The backfill always needs the embedder, regardless of the SEMANTIC_ENABLED runtime flag.
    const semantic = createSemanticServices({
      config: { ...env, semanticEnabled: true },
      pool,
      intents: new PgIntentRepository(pool),
    });
    if (!semantic) throw new Error('semantic services unavailable');
    const result = await semantic.backfill.execute();
    console.log(`backfill done: ${result.intents} intents, ${result.embedded} embedded, ${result.failed} failed (retry to fill them)`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
};

main().catch((error) => {
  console.error('backfill failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
