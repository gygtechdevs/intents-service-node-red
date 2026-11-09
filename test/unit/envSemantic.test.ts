import { beforeAll, describe, expect, it, vi } from 'vitest';

type Mod = typeof import('../../src/infrastructure/config/env');
let m: Mod;

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.stubEnv('AUTH_JWT_SECRET', 's');
  vi.stubEnv('INTERNAL_SECRET', 'i');
  m = await import('../../src/infrastructure/config/env');
});

describe('boolean flags', () => {
  it('parseSemanticEnabled: default false, only "true" enables', () => {
    expect(m.parseSemanticEnabled(undefined)).toBe(false);
    expect(m.parseSemanticEnabled('1')).toBe(false);
    expect(m.parseSemanticEnabled('true')).toBe(true);
  });
  it('parseDisambiguationEnabled: default true, only "false" disables', () => {
    expect(m.parseDisambiguationEnabled(undefined)).toBe(true);
    expect(m.parseDisambiguationEnabled('')).toBe(true);
    expect(m.parseDisambiguationEnabled('0')).toBe(true);
    expect(m.parseDisambiguationEnabled('false')).toBe(false);
  });
});

describe('numeric parsers (invalid -> default)', () => {
  it('parseSemanticMinSimilarity: (0,1], default 0.80', () => {
    for (const raw of [undefined, '', 'abc', '0', '-1', '1.5', 'NaN']) expect(m.parseSemanticMinSimilarity(raw)).toBe(0.8);
    expect(m.parseSemanticMinSimilarity('0.9')).toBe(0.9);
    expect(m.parseSemanticMinSimilarity('1')).toBe(1);
  });
  it('parseSemanticAmbiguityMargin: [0,1), default 0.05', () => {
    for (const raw of [undefined, '', 'abc', '-0.1', '1', '2']) expect(m.parseSemanticAmbiguityMargin(raw)).toBe(0.05);
    expect(m.parseSemanticAmbiguityMargin('0')).toBe(0);
    expect(m.parseSemanticAmbiguityMargin('0.1')).toBe(0.1);
  });
  it('parseSemanticTopK: positive int, default 5', () => {
    for (const raw of [undefined, '', 'x', '0', '-2', '1.5']) expect(m.parseSemanticTopK(raw)).toBe(5);
    expect(m.parseSemanticTopK('3')).toBe(3);
  });
  it('parseSemanticBudgetMs: positive int, default 1500', () => {
    for (const raw of [undefined, '', 'x', '0', '-2']) expect(m.parseSemanticBudgetMs(raw)).toBe(1500);
    expect(m.parseSemanticBudgetMs('2000')).toBe(2000);
  });
  it('parseBedrockEmbedTimeoutMs: positive int, default 800', () => {
    for (const raw of [undefined, 'x', '0']) expect(m.parseBedrockEmbedTimeoutMs(raw)).toBe(800);
    expect(m.parseBedrockEmbedTimeoutMs('500')).toBe(500);
  });
  it('parseBedrockLlmTimeoutMs: positive int, default 1000', () => {
    for (const raw of [undefined, 'x', '0']) expect(m.parseBedrockLlmTimeoutMs(raw)).toBe(1000);
    expect(m.parseBedrockLlmTimeoutMs('700')).toBe(700);
  });
  it('parseBreakerFailureThreshold: positive int, default 5', () => {
    for (const raw of [undefined, 'x', '0']) expect(m.parseBreakerFailureThreshold(raw)).toBe(5);
    expect(m.parseBreakerFailureThreshold('3')).toBe(3);
  });
  it('parseBreakerCooldownMs: positive int, default 30000', () => {
    for (const raw of [undefined, 'x', '0']) expect(m.parseBreakerCooldownMs(raw)).toBe(30000);
    expect(m.parseBreakerCooldownMs('1000')).toBe(1000);
  });
});

describe('string parsers', () => {
  it('model ids default and trim', () => {
    expect(m.parseEmbedModelId(undefined)).toBe('amazon.titan-embed-text-v2:0');
    expect(m.parseEmbedModelId('  ')).toBe('amazon.titan-embed-text-v2:0');
    expect(m.parseEmbedModelId(' custom ')).toBe('custom');
    expect(m.parseDisambiguatorModelId(undefined)).toBe('amazon.nova-micro-v1:0');
    expect(m.parseDisambiguatorModelId('other.model')).toBe('other.model');
  });
  it('parseAwsRegion: trimmed or undefined', () => {
    expect(m.parseAwsRegion(undefined)).toBeUndefined();
    expect(m.parseAwsRegion('  ')).toBeUndefined();
    expect(m.parseAwsRegion(' us-east-1 ')).toBe('us-east-1');
  });
});

describe('env object', () => {
  it('exposes the semantic defaults', () => {
    expect(m.env.semanticEnabled).toBe(false);
    expect(m.env.semanticMinSimilarity).toBe(0.8);
    expect(m.env.bedrockEmbedTimeoutMs).toBe(800);
    expect(m.env.breakerCooldownMs).toBe(30000);
  });
});
