import { describe, expect, it } from 'vitest';
import { SimulateImpactUseCase } from '../../src/application/use-cases/SimulateImpactUseCase';
import { FakeEmbedder } from '../fakes/FakeEmbedder';
import { InMemoryIntentExampleRepository } from '../fakes/InMemoryIntentExampleRepository';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

/** Unit vector at `deg` degrees in a plane: cosine between two vectors is cos(angle difference). */
const at = (deg: number): number[] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

const NOW = new Date('2026-06-30T12:00:00Z');
const options = { minSimilarity: 0.8, ambiguityMargin: 0.05, topK: 5 };

async function setup() {
  const unmatched = new InMemoryUnmatchedMessageRepository();
  const intents = new InMemoryIntentRepository();
  const examples = new InMemoryIntentExampleRepository();
  const embedder = new FakeEmbedder();
  for (const name of ['account', 'card', 'billing']) {
    await intents.create({ name, keywords: [name], tags: [], steps: { initialStep: `/s/${name}` } });
  }
  const useCase = new SimulateImpactUseCase({ unmatched, intents, examples, embedder, options, now: () => NOW });
  const example = (intent: string, text: string, deg: number, source: 'keyword' | 'approved' = 'approved') =>
    examples.upsertMany([{ intent, text, textHash: `${intent}:${text}`, source, embedding: at(deg) }]);
  const pending = (text: string, deg: number, extra: Record<string, unknown> = {}) => {
    embedder.set(text, at(deg));
    return unmatched.seed({ maskedText: text, lastSeenAt: new Date('2026-06-20T00:00:00Z'), ...extra });
  };
  return { unmatched, intents, examples, embedder, useCase, example, pending };
}

describe('SimulateImpactUseCase: newly matched', () => {
  it('counts pending messages that would match the target once the selection is approved', async () => {
    const { useCase, example, pending } = await setup();
    await example('card', 'block my card', 200);
    const selected = pending('i cannot log in', 0, { occurrences: 4 });
    const close = pending('cant login', 5, { occurrences: 2 });
    pending('what is the weather', 270);

    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });

    expect(result.intent).toBe('account');
    expect(result.newlyMatched.count).toBe(2);
    expect(result.newlyMatched.selected).toBe(1);
    expect(result.newlyMatched.others).toBe(1);
    expect(result.newlyMatched.occurrences).toBe(6);
    expect(result.newlyMatched.samples.map((s) => s.maskedText).sort()).toEqual(['cant login', 'i cannot log in']);
    expect(result.newlyMatched.samples.find((s) => s.id === close.id)?.similarity).toBeGreaterThan(0.99);
    expect(result.regressions.count).toBe(0);
  });

  it('is labelled as an estimate with its scope', async () => {
    const { useCase, example, pending } = await setup();
    await example('card', 'block my card', 200);
    const selected = pending('i cannot log in', 0);
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(result.scope).toMatchObject({
      exact: false,
      basis: 'pending-messages-and-stored-examples',
      replayedMessages: 1,
      examplesChecked: 1,
      minSimilarity: 0.8,
      ambiguityMargin: 0.05,
    });
  });

  it('only replays pending messages seen within the window (plus the selection)', async () => {
    const { useCase, pending } = await setup();
    const selected = pending('i cannot log in', 0);
    pending('cant login', 5, { lastSeenAt: new Date('2026-04-01T00:00:00Z') });
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(result.newlyMatched.count).toBe(1);
    expect(result.scope.replayedMessages).toBe(1);

    const wide = await useCase.execute({ intent: 'account', ids: [selected.id], days: 120 });
    expect(wide.newlyMatched.count).toBe(2);
  });

  it('caps samples at 10 but keeps the real count', async () => {
    const { useCase, pending } = await setup();
    const selected = pending('seed message', 0);
    for (let i = 0; i < 12; i++) pending(`variation ${i}`, i % 3);
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(result.newlyMatched.count).toBe(13);
    expect(result.newlyMatched.samples).toHaveLength(10);
  });

  it('does not count a message that is only ambiguous (left to the LLM)', async () => {
    const { useCase, example, pending } = await setup();
    await example('billing', 'invoice help', 12);
    const selected = pending('i cannot log in', 0);
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(result.newlyMatched.count).toBe(0);
    expect(result.ambiguous).toBe(1);
  });
});

describe('SimulateImpactUseCase: regressions', () => {
  it('reports stored examples of other intents that would switch to the target', async () => {
    const { useCase, example, pending } = await setup();
    // e1 is 25 degrees from the new example and 34 degrees from its own intent's other example.
    await example('billing', 'invoice question', 25, 'keyword');
    await example('billing', 'billing contact', 59, 'keyword');
    await example('card', 'block my card', 200);
    const selected = pending('i cannot log in', 0);

    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });

    const hit = result.regressions.samples.find((s) => s.maskedText === 'invoice question');
    expect(hit).toMatchObject({ from: 'billing', source: 'keyword' });
    expect(hit?.similarity).toBeGreaterThan(0.9);
    expect(result.regressions.samples.some((s) => s.maskedText === 'block my card')).toBe(false);
    expect(result.regressions.samples.some((s) => s.maskedText === 'billing contact')).toBe(false);
  });

  it('ignores examples that already belong to the target intent', async () => {
    const { useCase, example, pending } = await setup();
    await example('account', 'my account', 10);
    const selected = pending('i cannot log in', 0);
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(result.regressions.count).toBe(0);
  });

  it('flags a pending message that would currently match another intent but switches', async () => {
    const { useCase, example, pending } = await setup();
    await example('billing', 'invoice question', 25, 'keyword');
    await example('billing', 'billing contact', 59, 'keyword');
    const selected = pending('i cannot log in', 0);
    const result = await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    const fromPending = result.regressions.samples.find((s) => s.source === 'unmatched');
    expect(fromPending).toMatchObject({ maskedText: 'i cannot log in', from: 'billing' });
    expect(result.newlyMatched.count).toBe(0);
  });
});

describe('SimulateImpactUseCase: purity and errors', () => {
  it('does not mutate the unmatched store or the example store', async () => {
    const { useCase, unmatched, examples, example, pending } = await setup();
    await example('card', 'block my card', 200);
    const selected = pending('i cannot log in', 0);
    const before = JSON.stringify([unmatched.rows, examples.rows]);
    await useCase.execute({ intent: 'account', ids: [selected.id], days: 30 });
    expect(JSON.stringify([unmatched.rows, examples.rows])).toBe(before);
    expect(unmatched.rows[0]?.status).toBe('pending');
  });

  it('404 for an unknown or inactive target intent', async () => {
    const { useCase, intents, pending } = await setup();
    const selected = pending('x', 0);
    await expect(useCase.execute({ intent: 'nope', ids: [selected.id], days: 30 })).rejects.toMatchObject({
      statusCode: 404,
    });
    const account = await intents.findByName('account');
    await intents.save({ ...account!, active: false });
    await expect(useCase.execute({ intent: 'account', ids: [selected.id], days: 30 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('404 when none of the ids is a pending message', async () => {
    const { useCase, pending } = await setup();
    const done = pending('x', 0, { status: 'rejected' });
    await expect(
      useCase.execute({ intent: 'account', ids: [done.id, '99999999-9999-4999-8999-999999999999'], days: 30 }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('503 when the embedding service fails', async () => {
    const { useCase, embedder, pending } = await setup();
    const selected = pending('x', 0);
    embedder.failWith = new Error('bedrock down');
    await expect(useCase.execute({ intent: 'account', ids: [selected.id], days: 30 })).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
