import { describe, expect, it } from 'vitest';
import type { Intent } from '../../src/domain/entities/Intent';
import { HybridIntentClassifier, type HybridOptions } from '../../src/application/services/HybridIntentClassifier';
import { KeywordIntentClassifier } from '../../src/application/services/KeywordIntentClassifier';
import { EMBEDDING_DIMENSIONS } from '../../src/domain/ports/Embedder';
import { FakeDisambiguator } from '../fakes/FakeDisambiguator';
import { FakeEmbedder } from '../fakes/FakeEmbedder';
import { InMemoryIntentExampleRepository } from '../fakes/InMemoryIntentExampleRepository';

const mk = (name: string, keywords: string[]): Intent => ({
  id: name,
  name,
  keywords,
  tags: ['t'],
  initialStep: `${name}-step`,
  steps: {},
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const catalog = [mk('saldo', ['saldo']), mk('tarjeta', ['tarjeta']), mk('prestamo', ['prestamo'])];

/** Vector in the plane of dims 0/1 with the given cosine against e0. */
const vec = (cos: number): number[] => {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[0] = cos;
  v[1] = Math.sqrt(1 - cos * cos);
  return v;
};
const e0 = vec(1);

const OPTIONS: HybridOptions = {
  minSimilarity: 0.8,
  ambiguityMargin: 0.05,
  topK: 5,
  budgetMs: 1500,
  disambiguationEnabled: true,
};

const setup = (over: Partial<HybridOptions> = {}, withDisambiguator = true) => {
  const embedder = new FakeEmbedder();
  const examples = new InMemoryIntentExampleRepository();
  const disambiguator = new FakeDisambiguator();
  const errors: string[] = [];
  const classifier = new HybridIntentClassifier({
    keyword: new KeywordIntentClassifier(),
    embedder,
    examples,
    ...(withDisambiguator ? { disambiguator } : {}),
    options: { ...OPTIONS, ...over },
    logger: { error: (m: string) => errors.push(m) },
  });
  const seed = (intent: string, cos: number) =>
    examples.rows.push({
      id: `${intent}-${cos}`,
      intent,
      text: intent,
      textHash: `${intent}-${cos}`,
      source: 'keyword',
      embedding: vec(cos),
      embeddingModel: 'm',
    });
  return { embedder, examples, disambiguator, classifier, errors, seed };
};

describe('HybridIntentClassifier', () => {
  it('keyword hit returns immediately with source keyword and never touches the embedder', async () => {
    const { classifier, embedder } = setup();
    const r = await classifier.classify('quiero ver mi saldo', catalog);
    expect(r?.intent).toBe('saldo');
    expect(r?.source).toBe('keyword');
    expect(embedder.calls).toHaveLength(0);
  });

  it('keyword miss + similarity below min -> null', async () => {
    const { classifier, seed, embedder } = setup();
    embedder.set('hola que tal', e0);
    seed('saldo', 0.5);
    expect(await classifier.classify('hola que tal', catalog)).toBeNull();
  });

  it('clear margin -> semantic result without calling the LLM', async () => {
    const { classifier, seed, embedder, disambiguator } = setup();
    embedder.set('plata disponible', e0);
    seed('saldo', 0.95);
    seed('tarjeta', 0.7);
    const r = await classifier.classify('plata disponible', catalog);
    expect(r).toMatchObject({
      intent: 'saldo',
      initialStep: 'saldo-step',
      matchedKeywords: [],
      tags: ['t'],
      source: 'semantic',
    });
    expect(r?.confidence).toBeCloseTo(0.95, 5);
    expect(disambiguator.calls).toHaveLength(0);
  });

  it('uses the max similarity per intent (several examples of one intent are not ambiguity)', async () => {
    const { classifier, seed, embedder, disambiguator } = setup();
    embedder.set('plata disponible', e0);
    seed('saldo', 0.95);
    seed('saldo', 0.94);
    const r = await classifier.classify('plata disponible', catalog);
    expect(r?.source).toBe('semantic');
    expect(disambiguator.calls).toHaveLength(0);
  });

  it('ambiguity within margin -> Nova receives only the close candidates and its answer is used', async () => {
    const { classifier, seed, embedder, disambiguator } = setup();
    embedder.set('mi plata', e0);
    seed('saldo', 0.9);
    seed('tarjeta', 0.88);
    seed('prestamo', 0.6);
    disambiguator.answer = 'tarjeta';
    const r = await classifier.classify('mi plata', catalog);
    expect(disambiguator.calls).toHaveLength(1);
    expect(disambiguator.calls[0]?.candidates.map((c) => c.name).sort()).toEqual(['saldo', 'tarjeta']);
    expect(r).toMatchObject({ intent: 'tarjeta', source: 'llm' });
  });

  it('Nova answer outside the candidates or null -> null', async () => {
    const { classifier, seed, embedder, disambiguator } = setup();
    embedder.set('mi plata', e0);
    seed('saldo', 0.9);
    seed('tarjeta', 0.88);
    disambiguator.answer = 'prestamo';
    expect(await classifier.classify('mi plata', catalog)).toBeNull();
    disambiguator.answer = null;
    expect(await classifier.classify('mi plata', catalog)).toBeNull();
  });

  it('ambiguous but disambiguation disabled or no disambiguator -> null', async () => {
    for (const s of [setup({ disambiguationEnabled: false }), setup({}, false)]) {
      s.embedder.set('mi plata', e0);
      s.seed('saldo', 0.9);
      s.seed('tarjeta', 0.88);
      expect(await s.classifier.classify('mi plata', catalog)).toBeNull();
    }
  });

  it('Bedrock only receives masked text (embedder and Nova)', async () => {
    const { classifier, seed, embedder, disambiguator } = setup();
    const masked = 'mi plata [EMAIL]';
    embedder.set(masked, e0);
    seed('saldo', 0.9);
    seed('tarjeta', 0.88);
    disambiguator.answer = 'saldo';
    await classifier.classify('mi plata juan@example.com', catalog);
    expect(embedder.calls).toEqual([masked]);
    expect(disambiguator.calls[0]?.text).toBe(masked);
    expect(JSON.stringify([embedder.calls, disambiguator.calls])).not.toContain('juan@example.com');
  });

  it('intents unknown to the catalog are dropped', async () => {
    const { classifier, seed, embedder } = setup();
    embedder.set('hola', e0);
    seed('ghost', 0.99);
    expect(await classifier.classify('hola', catalog)).toBeNull();
  });

  it('embedder error -> null, never throws, logs only the message', async () => {
    const { classifier, embedder, errors } = setup();
    embedder.failWith = new Error('boom');
    expect(await classifier.classify('algo raro', catalog)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('boom');
    expect(errors[0]).not.toContain('algo raro');
  });

  it('search error and disambiguator error -> null', async () => {
    const a = setup();
    a.examples.searchFailure = new Error('db down');
    expect(await a.classifier.classify('x y', catalog)).toBeNull();

    const b = setup();
    b.embedder.set('mi plata', e0);
    b.seed('saldo', 0.9);
    b.seed('tarjeta', 0.88);
    b.disambiguator.failWith = new Error('nova down');
    expect(await b.classifier.classify('mi plata', catalog)).toBeNull();
  });

  it('budget exhausted while embedding -> null within the budget', async () => {
    const { classifier, embedder } = setup({ budgetMs: 30 });
    embedder.delayMs = 500;
    const started = Date.now();
    expect(await classifier.classify('algo raro', catalog)).toBeNull();
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('too little budget left for the LLM -> no Nova call', async () => {
    const { classifier, seed, embedder, disambiguator } = setup({ budgetMs: 100 });
    embedder.set('mi plata', e0);
    embedder.delayMs = 20;
    seed('saldo', 0.9);
    seed('tarjeta', 0.88);
    disambiguator.answer = 'saldo';
    // remaining (~80ms) is below the 300ms minimum for the LLM step
    expect(await classifier.classify('mi plata', catalog)).toBeNull();
    expect(disambiguator.calls).toHaveLength(0);
  });

  it('text that masks to nothing -> null without embedding', async () => {
    const { classifier, embedder } = setup();
    expect(await classifier.classify('   ', catalog)).toBeNull();
    expect(embedder.calls).toHaveLength(0);
  });
});
