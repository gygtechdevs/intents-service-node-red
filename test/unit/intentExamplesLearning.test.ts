import { describe, expect, it } from 'vitest';
import { BackfillIntentExamplesUseCase } from '../../src/application/use-cases/BackfillIntentExamplesUseCase';
import { EmbedPendingExamplesUseCase } from '../../src/application/use-cases/EmbedPendingExamplesUseCase';
import { CreateIntentUseCase } from '../../src/application/use-cases/CreateIntentUseCase';
import { UpdateIntentUseCase } from '../../src/application/use-cases/UpdateIntentUseCase';
import { IntentExamplesSyncer, deriveExamples, type IntentExamplesSync } from '../../src/application/services/IntentExamplesSync';
import type { Intent } from '../../src/domain/entities/Intent';
import { FakeEmbedder } from '../fakes/FakeEmbedder';
import { InMemoryIntentExampleRepository } from '../fakes/InMemoryIntentExampleRepository';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('deriveExamples', () => {
  it('turns keywords and description into deduplicated hashed examples', () => {
    const intent = { keywords: ['Saldo', 'saldo ', 'cuenta'], description: 'Consulta de saldo' } as Intent;
    const out = deriveExamples(intent);
    expect(out.map((e) => [e.source, e.text])).toEqual([
      ['keyword', 'Saldo'],
      ['keyword', 'cuenta'],
      ['description', 'Consulta de saldo'],
    ]);
    expect(out.every((e) => /^[0-9a-f]{64}$/.test(e.textHash))).toBe(true);
  });
});

describe('EmbedPendingExamplesUseCase', () => {
  const seed = (repo: InMemoryIntentExampleRepository, n: number) => {
    for (let i = 0; i < n; i += 1) {
      repo.rows.push({ id: `${i}`, intent: 'a', text: `t${i}`, textHash: `h${i}`, source: 'keyword', embedding: null, embeddingModel: null });
    }
  };

  it('embeds every pending row across batches and records the model', async () => {
    const repo = new InMemoryIntentExampleRepository();
    seed(repo, 5);
    const uc = new EmbedPendingExamplesUseCase(repo, new FakeEmbedder(), { modelId: 'titan', batchSize: 2, concurrency: 2 });
    const result = await uc.execute();
    expect(result).toEqual({ embedded: 5, failed: 0 });
    expect(repo.rows.every((r) => r.embedding && r.embeddingModel === 'titan')).toBe(true);
  });

  it('failures stay NULL for a later sweep, do not loop forever and never throw', async () => {
    const repo = new InMemoryIntentExampleRepository();
    seed(repo, 3);
    const embedder = new FakeEmbedder();
    embedder.failWith = new Error('down');
    const result = await new EmbedPendingExamplesUseCase(repo, embedder, { modelId: 'm', batchSize: 2 }).execute();
    expect(result).toEqual({ embedded: 0, failed: 3 });
    expect(repo.rows.every((r) => r.embedding === null)).toBe(true);

    embedder.failWith = null;
    expect(await new EmbedPendingExamplesUseCase(repo, embedder, { modelId: 'm' }).execute()).toEqual({ embedded: 3, failed: 0 });
  });
});

describe('BackfillIntentExamplesUseCase', () => {
  const build = async () => {
    const intents = new InMemoryIntentRepository();
    await intents.create({ name: 'saldo', keywords: ['saldo', 'cuenta'], tags: [], steps: { initialStep: 's', description: 'ver saldo' } });
    await intents.create({ name: 'tarjeta', keywords: ['tarjeta'], tags: [], steps: { initialStep: 't' } });
    const examples = new InMemoryIntentExampleRepository();
    const embedder = new FakeEmbedder();
    const embed = new EmbedPendingExamplesUseCase(examples, embedder, { modelId: 'm' });
    return { intents, examples, embedder, uc: new BackfillIntentExamplesUseCase(intents, examples, embed) };
  };

  it('creates examples from keywords and descriptions and embeds them', async () => {
    const { uc, examples } = await build();
    const result = await uc.execute();
    expect(result).toMatchObject({ intents: 2, embedded: 4, failed: 0 });
    expect(examples.rows.map((r) => `${r.intent}:${r.source}:${r.text}`).sort()).toEqual([
      'saldo:description:ver saldo',
      'saldo:keyword:cuenta',
      'saldo:keyword:saldo',
      'tarjeta:keyword:tarjeta',
    ]);
  });

  it('is idempotent: a second run adds nothing and re-embeds nothing', async () => {
    const { uc, examples, embedder } = await build();
    await uc.execute();
    const calls = embedder.calls.length;
    const result = await uc.execute();
    expect(examples.rows).toHaveLength(4);
    expect(embedder.calls.length).toBe(calls);
    expect(result).toMatchObject({ embedded: 0, failed: 0 });
  });

  it('retries rows whose embedding is NULL', async () => {
    const { uc, examples, embedder } = await build();
    embedder.failWith = new Error('down');
    expect(await uc.execute()).toMatchObject({ embedded: 0, failed: 4 });
    embedder.failWith = null;
    expect(await uc.execute()).toMatchObject({ embedded: 4, failed: 0 });
    expect(examples.rows.every((r) => r.embedding)).toBe(true);
  });
});

describe('IntentExamplesSync hook in Create/Update use cases', () => {
  const build = () => {
    const intents = new InMemoryIntentRepository();
    const calls: string[] = [];
    const sync: IntentExamplesSync = { sync: async (i) => void calls.push(i.name) };
    return { intents, calls, sync };
  };

  it('create syncs the new intent in the background', async () => {
    const { intents, calls, sync } = build();
    await new CreateIntentUseCase(intents, sync).execute({ name: 'saldo', keywords: ['saldo'], initialStep: 's' });
    await flush();
    expect(calls).toEqual(['saldo']);
  });

  it('update syncs only when keywords or description change', async () => {
    const { intents, calls, sync } = build();
    await new CreateIntentUseCase(intents).execute({ name: 'saldo', keywords: ['saldo'], initialStep: 's', description: 'd' });
    const update = new UpdateIntentUseCase(intents, sync);

    await update.execute('saldo', { tags: ['x'] });
    await update.execute('saldo', { initialStep: 'other' });
    await update.execute('saldo', { keywords: ['saldo'], description: 'd' });
    await flush();
    expect(calls).toEqual([]);

    await update.execute('saldo', { keywords: ['saldo', 'cuenta'] });
    await update.execute('saldo', { description: 'nueva' });
    await flush();
    expect(calls).toEqual(['saldo', 'saldo']);
  });

  it('a failing sync (reject or sync throw) never fails or delays the write', async () => {
    const intents = new InMemoryIntentRepository();
    const rejecting: IntentExamplesSync = { sync: () => Promise.reject(new Error('embed down')) };
    const throwing: IntentExamplesSync = {
      sync: () => {
        throw new Error('sync boom');
      },
    };
    const created = await new CreateIntentUseCase(intents, rejecting).execute({ name: 'a', keywords: ['a'], initialStep: 's' });
    expect(created.name).toBe('a');
    const updated = await new UpdateIntentUseCase(intents, throwing).execute('a', { keywords: ['b'] });
    expect(updated.keywords).toEqual(['b']);
    await flush();
  });

  it('the syncer replaces derived examples and embeds them', async () => {
    const examples = new InMemoryIntentExampleRepository();
    const embed = new EmbedPendingExamplesUseCase(examples, new FakeEmbedder(), { modelId: 'm' });
    const syncer = new IntentExamplesSyncer(examples, embed);
    const intents = new InMemoryIntentRepository();
    const intent = await intents.create({ name: 'saldo', keywords: ['saldo', 'cuenta'], tags: [], steps: { initialStep: 's' } });
    await syncer.sync(intent);
    expect(examples.rows).toHaveLength(2);
    expect(examples.rows.every((r) => r.embedding)).toBe(true);

    await syncer.sync({ ...intent, keywords: ['saldo'] });
    expect(examples.rows.map((r) => r.text)).toEqual(['saldo']);
  });
});
