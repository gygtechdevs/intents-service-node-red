import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { HybridIntentClassifier } from '../../src/application/services/HybridIntentClassifier';
import {
  createSemanticServices,
  type SemanticConfig,
} from '../../src/infrastructure/semantic/createSemanticServices';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const config: SemanticConfig = {
  semanticEnabled: true,
  awsRegion: 'us-east-1',
  semanticMinSimilarity: 0.8,
  semanticAmbiguityMargin: 0.05,
  semanticTopK: 5,
  semanticBudgetMs: 1500,
  disambiguationEnabled: true,
  bedrockEmbedTimeoutMs: 800,
  bedrockLlmTimeoutMs: 1000,
  breakerFailureThreshold: 5,
  breakerCooldownMs: 30000,
  bedrockEmbedModelId: 'titan',
  bedrockDisambiguatorModelId: 'nova',
};
const pool = { query: vi.fn() } as unknown as Pool;
const client = { send: vi.fn() };

describe('createSemanticServices', () => {
  it('returns null when SEMANTIC_ENABLED=false (keyword-only) without touching AWS', () => {
    const create = vi.fn();
    const out = createSemanticServices({
      config: { ...config, semanticEnabled: false, awsRegion: undefined },
      pool,
      intents: new InMemoryIntentRepository(),
      createClient: create,
    });
    expect(out).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('throws at startup when enabled and AWS_REGION is missing', () => {
    expect(() =>
      createSemanticServices({
        config: { ...config, awsRegion: undefined },
        pool,
        intents: new InMemoryIntentRepository(),
        createClient: () => client,
      }),
    ).toThrow(/AWS_REGION/);
  });

  it('builds the hybrid classifier, sync hook and backfill when enabled; one client per region', () => {
    const create = vi.fn().mockReturnValue(client);
    const out = createSemanticServices({ config, pool, intents: new InMemoryIntentRepository(), createClient: create });
    expect(out?.classifier).toBeInstanceOf(HybridIntentClassifier);
    expect(out?.examplesSync).toBeDefined();
    expect(out?.backfill).toBeDefined();
    // Dependencies for the admin review endpoints (approve / reembed).
    expect(out?.review.embedModelId).toBe('titan');
    expect(out?.review.examples).toBeDefined();
    expect(out?.review.embedder).toBeDefined();
    expect(typeof out?.review.reembed.execute).toBe('function');
    expect(create).toHaveBeenCalledWith('us-east-1');
  });

  it('omits the disambiguator when DISAMBIGUATION_ENABLED=false', () => {
    const out = createSemanticServices({
      config: { ...config, disambiguationEnabled: false },
      pool,
      intents: new InMemoryIntentRepository(),
      createClient: () => client,
    });
    expect(out?.classifier).toBeInstanceOf(HybridIntentClassifier);
  });
});
