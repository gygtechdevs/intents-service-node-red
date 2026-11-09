import type { Pool } from 'pg';
import { HybridIntentClassifier } from '../../application/services/HybridIntentClassifier';
import { IntentExamplesSyncer, type IntentExamplesSync } from '../../application/services/IntentExamplesSync';
import { KeywordIntentClassifier } from '../../application/services/KeywordIntentClassifier';
import { BackfillIntentExamplesUseCase } from '../../application/use-cases/BackfillIntentExamplesUseCase';
import { EmbedPendingExamplesUseCase } from '../../application/use-cases/EmbedPendingExamplesUseCase';
import type { UnmatchedReviewDependencies } from '../../app';
import type { IntentClassifier } from '../../domain/ports/IntentClassifier';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import { createBedrockClient, type BedrockSender } from '../bedrock/bedrockClient';
import { NovaDisambiguator } from '../bedrock/NovaDisambiguator';
import { TitanEmbedder } from '../bedrock/TitanEmbedder';
import { CircuitBreaker } from '../resilience/CircuitBreaker';
import { PgIntentExampleRepository } from '../repositories/PgIntentExampleRepository';

/** The subset of `env` the semantic wiring needs. */
export interface SemanticConfig {
  semanticEnabled: boolean;
  awsRegion: string | undefined;
  semanticMinSimilarity: number;
  semanticAmbiguityMargin: number;
  semanticTopK: number;
  semanticBudgetMs: number;
  disambiguationEnabled: boolean;
  bedrockEmbedTimeoutMs: number;
  bedrockLlmTimeoutMs: number;
  breakerFailureThreshold: number;
  breakerCooldownMs: number;
  bedrockEmbedModelId: string;
  bedrockDisambiguatorModelId: string;
}

export interface SemanticServices {
  classifier: IntentClassifier;
  examplesSync: IntentExamplesSync;
  backfill: BackfillIntentExamplesUseCase;
  /** What the admin review endpoints need to embed and store approved examples. */
  review: UnmatchedReviewDependencies;
}

export interface SemanticWiringDeps {
  config: SemanticConfig;
  pool: Pool;
  intents: IntentRepository;
  /** Injectable for tests; defaults to the real Bedrock runtime client. */
  createClient?: (region: string) => BedrockSender;
}

/**
 * Builds the semantic stack, or returns null (keyword-only behaviour) when SEMANTIC_ENABLED=false.
 * Throws when enabled without AWS_REGION so a misconfigured deploy fails at startup, not per request.
 * Each Bedrock adapter gets its own circuit breaker.
 */
export function createSemanticServices({
  config,
  pool,
  intents,
  createClient = createBedrockClient,
}: SemanticWiringDeps): SemanticServices | null {
  if (!config.semanticEnabled) return null;
  if (!config.awsRegion) {
    throw new Error('SEMANTIC_ENABLED=true requires AWS_REGION to be set');
  }

  const client = createClient(config.awsRegion);
  const newBreaker = () =>
    new CircuitBreaker({ failureThreshold: config.breakerFailureThreshold, cooldownMs: config.breakerCooldownMs });

  const embedder = new TitanEmbedder({
    client,
    modelId: config.bedrockEmbedModelId,
    timeoutMs: config.bedrockEmbedTimeoutMs,
    breaker: newBreaker(),
  });
  const disambiguator = config.disambiguationEnabled
    ? new NovaDisambiguator({
        client,
        modelId: config.bedrockDisambiguatorModelId,
        timeoutMs: config.bedrockLlmTimeoutMs,
        breaker: newBreaker(),
      })
    : undefined;

  const examples = new PgIntentExampleRepository(pool);
  const embedPending = new EmbedPendingExamplesUseCase(examples, embedder, { modelId: config.bedrockEmbedModelId });

  return {
    classifier: new HybridIntentClassifier({
      keyword: new KeywordIntentClassifier(),
      embedder,
      examples,
      ...(disambiguator ? { disambiguator } : {}),
      options: {
        minSimilarity: config.semanticMinSimilarity,
        ambiguityMargin: config.semanticAmbiguityMargin,
        topK: config.semanticTopK,
        budgetMs: config.semanticBudgetMs,
        disambiguationEnabled: config.disambiguationEnabled,
      },
    }),
    examplesSync: new IntentExamplesSyncer(examples, embedPending),
    backfill: new BackfillIntentExamplesUseCase(intents, examples, embedPending),
    review: {
      examples,
      embedder,
      embedModelId: config.bedrockEmbedModelId,
      reembed: { execute: () => embedPending.execute() },
      matching: {
        minSimilarity: config.semanticMinSimilarity,
        ambiguityMargin: config.semanticAmbiguityMargin,
        topK: config.semanticTopK,
      },
    },
  };
}
