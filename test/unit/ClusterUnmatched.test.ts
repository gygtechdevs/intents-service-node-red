import { describe, expect, it } from 'vitest';
import { ClusterUnmatchedUseCase } from '../../src/application/use-cases/ClusterUnmatchedUseCase';
import { FakeEmbedder } from '../fakes/FakeEmbedder';
import { InMemoryIntentExampleRepository } from '../fakes/InMemoryIntentExampleRepository';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

async function setup() {
  const unmatched = new InMemoryUnmatchedMessageRepository();
  const intents = new InMemoryIntentRepository();
  const examples = new InMemoryIntentExampleRepository();
  const embedder = new FakeEmbedder();
  await intents.create({ name: 'password', keywords: ['reset password'], tags: [], steps: { initialStep: '/s/pw' } });
  await intents.create({ name: 'card', keywords: ['block card'], tags: [], steps: { initialStep: '/s/card' } });
  return { unmatched, intents, examples, embedder };
}

describe('ClusterUnmatchedUseCase (semantic)', () => {
  it('groups similar pending messages, sums occurrences and reports the nearest intent', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    const a1 = unmatched.seed({
      maskedText: 'i want to reset my password',
      occurrences: 5,
      firstSeenAt: new Date('2026-03-01T00:00:00Z'),
      lastSeenAt: new Date('2026-03-05T00:00:00Z'),
    });
    const a2 = unmatched.seed({
      maskedText: 'forgot my login secret',
      occurrences: 2,
      firstSeenAt: new Date('2026-02-20T00:00:00Z'),
      lastSeenAt: new Date('2026-03-09T00:00:00Z'),
    });
    const b = unmatched.seed({ maskedText: 'my card was stolen', occurrences: 3 });
    unmatched.seed({ maskedText: 'already handled', occurrences: 99, status: 'rejected' });
    embedder.set(a1.maskedText, [1, 0]).set(a2.maskedText, [0.98, 0.2]).set(b.maskedText, [0, 1]);
    await examples.upsertMany([
      { intent: 'password', text: 'pw', textHash: 'h1', source: 'keyword', embedding: [1, 0.05] },
      { intent: 'card', text: 'cd', textHash: 'h2', source: 'keyword', embedding: [0.1, 1] },
    ]);

    const result = await new ClusterUnmatchedUseCase({ unmatched, intents, examples, embedder }).execute();

    expect(result.method).toBe('semantic');
    expect(result.clusters).toHaveLength(2);
    const [first, second] = result.clusters;
    expect(first).toMatchObject({
      representativeText: 'i want to reset my password',
      size: 7,
      memberIds: [a1.id, a2.id],
      firstSeenAt: new Date('2026-02-20T00:00:00Z'),
      lastSeenAt: new Date('2026-03-09T00:00:00Z'),
    });
    expect(first?.nearestIntent?.intent).toBe('password');
    expect(first?.nearestIntent?.similarity).toBeGreaterThan(0.9);
    expect(first?.members.map((m) => m.maskedText)).toEqual(['i want to reset my password', 'forgot my login secret']);
    expect(second).toMatchObject({ size: 3, memberIds: [b.id] });
    expect(second?.nearestIntent?.intent).toBe('card');
    expect(first?.id).toMatch(/^[0-9a-f]{12}$/);
    expect(first?.id).not.toBe(second?.id);
  });

  it('keeps the same cluster id when called again with the same members', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    unmatched.seed({ maskedText: 'x one' });
    const useCase = new ClusterUnmatchedUseCase({ unmatched, intents, examples, embedder });
    expect((await useCase.execute()).clusters[0]?.id).toBe((await useCase.execute()).clusters[0]?.id);
  });

  it('returns null nearestIntent when there are no embedded examples', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    unmatched.seed({ maskedText: 'anything' });
    const result = await new ClusterUnmatchedUseCase({ unmatched, intents, examples, embedder }).execute();
    expect(result.clusters[0]?.nearestIntent).toBeNull();
  });

  it('sorts clusters by size, largest first', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    const small = unmatched.seed({ maskedText: 'small', occurrences: 1 });
    const big = unmatched.seed({ maskedText: 'big', occurrences: 8 });
    embedder.set('small', [1, 0]).set('big', [0, 1]);
    const result = await new ClusterUnmatchedUseCase({ unmatched, intents, examples, embedder }).execute();
    expect(result.clusters.map((c) => c.memberIds[0])).toEqual([big.id, small.id]);
  });

  it('reports truncated when more pending messages exist than maxItems', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    for (let i = 0; i < 5; i++) unmatched.seed({ maskedText: `message ${i}`, occurrences: 10 - i });
    const result = await new ClusterUnmatchedUseCase({
      unmatched,
      intents,
      examples,
      embedder,
      options: { maxItems: 3 },
    }).execute();
    expect(result.truncated).toBe(true);
    expect(result.analyzed).toBe(3);
    expect(result.clusters.flatMap((c) => c.memberIds)).toHaveLength(3);
  });
});

describe('ClusterUnmatchedUseCase (lexical fallback)', () => {
  it('uses token-set similarity when there is no embedder, and nearest intent from keywords', async () => {
    const { unmatched, intents } = await setup();
    const a = unmatched.seed({ maskedText: 'reset my password', occurrences: 2 });
    const b = unmatched.seed({ maskedText: 'reset password please', occurrences: 1 });
    unmatched.seed({ maskedText: 'completely different words', occurrences: 1 });

    const result = await new ClusterUnmatchedUseCase({ unmatched, intents }).execute();

    expect(result.method).toBe('lexical');
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]).toMatchObject({ size: 3, memberIds: [a.id, b.id] });
    expect(result.clusters[0]?.nearestIntent?.intent).toBe('password');
    expect(result.clusters[1]?.nearestIntent).toBeNull();
  });

  it('falls back to lexical for the whole run when embedding fails', async () => {
    const { unmatched, intents, examples, embedder } = await setup();
    embedder.failWith = new Error('bedrock down');
    unmatched.seed({ maskedText: 'reset my password' });
    unmatched.seed({ maskedText: 'reset password please' });
    const result = await new ClusterUnmatchedUseCase({ unmatched, intents, examples, embedder }).execute();
    expect(result.method).toBe('lexical');
    expect(result.clusters).toHaveLength(1);
  });

  it('returns no clusters when nothing is pending', async () => {
    const { unmatched, intents } = await setup();
    const result = await new ClusterUnmatchedUseCase({ unmatched, intents }).execute();
    expect(result).toMatchObject({ method: 'lexical', clusters: [], truncated: false, analyzed: 0 });
  });
});
