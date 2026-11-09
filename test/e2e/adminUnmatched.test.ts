import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { HybridIntentClassifier } from '../../src/application/services/HybridIntentClassifier';
import { KeywordIntentClassifier } from '../../src/application/services/KeywordIntentClassifier';
import { EmbedPendingExamplesUseCase } from '../../src/application/use-cases/EmbedPendingExamplesUseCase';
import { FakeEmbedder } from '../fakes/FakeEmbedder';
import { InMemoryIntentExampleRepository } from '../fakes/InMemoryIntentExampleRepository';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryUnmatchedMessageRepository } from '../fakes/InMemoryUnmatchedMessageRepository';

const config = { jwtSecret: 'j', internalSecret: 'i' };
const bearer = (permissions: string[], sub = 'admin-1') => `Bearer ${jwt.sign({ sub, permissions }, 'j')}`;
const ADMIN = bearer(['ADMIN']);
const WRITER = bearer(['WRITE']);
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

function setup() {
  const repository = new InMemoryIntentRepository();
  const unmatched = new InMemoryUnmatchedMessageRepository();
  const examples = new InMemoryIntentExampleRepository();
  const embedder = new FakeEmbedder();
  const reembed = new EmbedPendingExamplesUseCase(examples, embedder, { modelId: 'titan' });
  const classifier = new HybridIntentClassifier({
    keyword: new KeywordIntentClassifier(),
    embedder,
    examples,
    options: { minSimilarity: 0.8, ambiguityMargin: 0.05, topK: 5, budgetMs: 1500, disambiguationEnabled: false },
  });
  const app = createApp({
    repository,
    config,
    classifier,
    unmatched,
    unmatchedReview: { examples, embedder, embedModelId: 'titan', reembed },
  });
  const detect = (text: string) => request(app).post('/intents/detect').set('X-Internal-Secret', 'i').send({ text });
  return { app, repository, unmatched, examples, embedder, detect };
}

async function addIntent(repository: InMemoryIntentRepository, name: string, keywords: string[]) {
  await repository.create({ name, keywords, tags: [], steps: { initialStep: `/stepin/${name}` } });
}

describe('admin unmatched review: auth', () => {
  const routes: Array<[string, string]> = [
    ['get', '/admin/unmatched'],
    ['post', `/admin/unmatched/${UNKNOWN_ID}/approve`],
    ['post', `/admin/unmatched/${UNKNOWN_ID}/approve-new`],
    ['post', `/admin/unmatched/${UNKNOWN_ID}/reject`],
    ['post', '/admin/intent-examples/reembed'],
  ];

  it.each(routes)('%s %s -> 401 without a token', async (method, path) => {
    const { app } = setup();
    const res = await (request(app) as any)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it.each(routes)('%s %s -> 403 without ADMIN', async (method, path) => {
    const { app } = setup();
    const res = await (request(app) as any)[method](path).set('Authorization', WRITER).send({});
    expect(res.status).toBe(403);
  });

  it('is not mounted when no unmatched store is wired', async () => {
    const app = createApp({ repository: new InMemoryIntentRepository(), config });
    const res = await request(app).get('/admin/unmatched').set('Authorization', ADMIN);
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/unmatched', () => {
  it('lists pending items, most frequent first, masked text only', async () => {
    const { app, unmatched } = setup();
    unmatched.seed({ maskedText: 'low', occurrences: 1 });
    unmatched.seed({ maskedText: 'high', occurrences: 9 });
    unmatched.seed({ maskedText: 'mid [DNI]', occurrences: 4 });
    unmatched.seed({ maskedText: 'done', occurrences: 50, status: 'rejected' });

    const res = await request(app).get('/admin/unmatched').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { maskedText: string }) => i.maskedText)).toEqual(['high', 'mid [DNI]', 'low']);
    expect(res.body.items[0]).toMatchObject({ status: 'pending', occurrences: 9 });
    expect(res.body.items[0]).not.toHaveProperty('textHash');
  });

  it('filters by status and honours limit', async () => {
    const { app, unmatched } = setup();
    unmatched.seed({ maskedText: 'a', occurrences: 3 });
    unmatched.seed({ maskedText: 'b', occurrences: 2 });
    unmatched.seed({ maskedText: 'r', status: 'rejected' });
    const limited = await request(app).get('/admin/unmatched?limit=1').set('Authorization', ADMIN);
    expect(limited.body.items).toHaveLength(1);
    const rejected = await request(app).get('/admin/unmatched?status=rejected').set('Authorization', ADMIN);
    expect(rejected.body.items.map((i: { maskedText: string }) => i.maskedText)).toEqual(['r']);
  });

  it('pages through rows with equal occurrences and equal last_seen_at without skips or repeats', async () => {
    const { app, unmatched } = setup();
    const at = new Date('2026-03-01T10:00:00.000Z');
    for (let i = 0; i < 7; i++) unmatched.seed({ maskedText: `tie-${i}`, occurrences: 5, lastSeenAt: at });
    unmatched.seed({ maskedText: 'top', occurrences: 9, lastSeenAt: new Date('2026-01-01T00:00:00Z') });
    unmatched.seed({ maskedText: 'low', occurrences: 1, lastSeenAt: new Date('2026-04-01T00:00:00Z') });
    unmatched.seed({ maskedText: 'rej', occurrences: 5, lastSeenAt: at, status: 'rejected' });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/admin/unmatched?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await request(app).get(url).set('Authorization', ADMIN);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    const all = await request(app).get('/admin/unmatched?limit=100').set('Authorization', ADMIN);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual(seen);
  });

  it('returns a null nextCursor when the page is the last one', async () => {
    const { app, unmatched } = setup();
    unmatched.seed({ maskedText: 'a' });
    unmatched.seed({ maskedText: 'b' });
    const res = await request(app).get('/admin/unmatched?limit=2').set('Authorization', ADMIN);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });

  it.each(['status=bogus', 'limit=0', 'limit=1000', 'limit=abc', 'cursor=!!!','cursor=e30','cursor=' + Buffer.from(JSON.stringify({ o: 1, t: 'x', i: 'y' })).toString('base64url')])('400 for %s', async (qs) => {
    const { app } = setup();
    const res = await request(app).get(`/admin/unmatched?${qs}`).set('Authorization', ADMIN);
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/unmatched/:id/approve', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await addIntent(ctx.repository, 'saldo', ['saldo']);
  });

  it('approves, stores an embedded example and the next detection matches', async () => {
    const row = ctx.unmatched.seed({ maskedText: 'cuanta plata tengo' });
    expect((await ctx.detect('cuanta plata tengo')).body.intent).toBeNull();

    const res = await request(ctx.app)
      .post(`/admin/unmatched/${row.id}/approve`)
      .set('Authorization', ADMIN)
      .send({ intent: 'saldo' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: row.id, status: 'approved', intent: 'saldo', embedded: true });
    expect(row).toMatchObject({ status: 'approved', resolvedIntent: 'saldo', resolvedBy: 'admin-1' });
    expect(ctx.examples.rows).toHaveLength(1);
    expect(ctx.examples.rows[0]).toMatchObject({ intent: 'saldo', source: 'approved', embeddingModel: 'titan' });
    expect(ctx.examples.rows[0]?.embedding).not.toBeNull();

    const next = await ctx.detect('cuanta plata tengo');
    expect(next.body).toMatchObject({ intent: 'saldo', source: 'semantic' });
  });

  it('still succeeds when embedding fails: example kept with NULL embedding, embedded=false', async () => {
    ctx.embedder.failWith = new Error('bedrock down');
    const row = ctx.unmatched.seed({ maskedText: 'cuanta plata tengo' });
    const res = await request(ctx.app)
      .post(`/admin/unmatched/${row.id}/approve`)
      .set('Authorization', ADMIN)
      .send({ intent: 'saldo' });
    expect(res.status).toBe(200);
    expect(res.body.embedded).toBe(false);
    expect(row.status).toBe('approved');
    expect(ctx.examples.rows).toHaveLength(1);
    expect(ctx.examples.rows[0]?.embedding).toBeNull();
    expect((await ctx.detect('cuanta plata tengo')).body.intent).toBeNull();
  });

  it('reverts the approval when saving the example fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(ctx.examples, 'upsertMany').mockRejectedValue(new Error('db down'));
    const row = ctx.unmatched.seed({ maskedText: 'cuanta plata tengo' });
    const res = await request(ctx.app)
      .post(`/admin/unmatched/${row.id}/approve`)
      .set('Authorization', ADMIN)
      .send({ intent: 'saldo' });
    expect(res.status).toBe(500);
    expect(row).toMatchObject({ status: 'pending', resolvedBy: null, resolvedIntent: null });
    spy.mockRestore();
  });

  it('404 for an unknown or malformed id, and for an unknown intent (item stays pending)', async () => {
    const row = ctx.unmatched.seed({ maskedText: 'x' });
    const post = (id: string, body: unknown) =>
      request(ctx.app).post(`/admin/unmatched/${id}/approve`).set('Authorization', ADMIN).send(body as object);
    expect((await post(UNKNOWN_ID, { intent: 'saldo' })).status).toBe(404);
    expect((await post('not-a-uuid', { intent: 'saldo' })).status).toBe(404);
    expect((await post(row.id, { intent: 'nope' })).status).toBe(404);
    expect(row.status).toBe('pending');
    expect(ctx.examples.rows).toHaveLength(0);
  });

  it('404 for a soft-deleted intent', async () => {
    const intent = await ctx.repository.findByName('saldo');
    await ctx.repository.save({ ...intent!, active: false });
    const row = ctx.unmatched.seed({ maskedText: 'x' });
    const res = await request(ctx.app)
      .post(`/admin/unmatched/${row.id}/approve`)
      .set('Authorization', ADMIN)
      .send({ intent: 'saldo' });
    expect(res.status).toBe(404);
  });

  it('400 when intent is missing or not a string', async () => {
    const row = ctx.unmatched.seed({ maskedText: 'x' });
    for (const body of [{}, { intent: 5 }]) {
      const res = await request(ctx.app)
        .post(`/admin/unmatched/${row.id}/approve`)
        .set('Authorization', ADMIN)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it('409 when the item is already resolved', async () => {
    const row = ctx.unmatched.seed({ maskedText: 'x' });
    const send = () =>
      request(ctx.app).post(`/admin/unmatched/${row.id}/approve`).set('Authorization', ADMIN).send({ intent: 'saldo' });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(409);
    expect(ctx.examples.rows).toHaveLength(1);
  });

  it('concurrent approvals: exactly one wins', async () => {
    const row = ctx.unmatched.seed({ maskedText: 'x' });
    const send = () =>
      request(ctx.app).post(`/admin/unmatched/${row.id}/approve`).set('Authorization', ADMIN).send({ intent: 'saldo' });
    const statuses = (await Promise.all([send(), send()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(ctx.examples.rows).toHaveLength(1);
  });
});

describe('POST /admin/unmatched/:id/approve-new', () => {
  it('creates the intent plus the example; detection sees both', async () => {
    const { app, unmatched, examples, detect, repository } = setup();
    const row = unmatched.seed({ maskedText: 'quiero cambiar mi clave' });
    const res = await request(app)
      .post(`/admin/unmatched/${row.id}/approve-new`)
      .set('Authorization', ADMIN)
      .send({ name: 'clave', initialStep: '/stepin/clave', keywords: ['clave'], description: 'cambio de clave' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: row.id, status: 'approved', intent: 'clave', embedded: true });
    expect(await repository.findByName('clave')).toMatchObject({ active: true });
    expect(row).toMatchObject({ status: 'approved', resolvedIntent: 'clave' });
    expect(examples.rows.some((e) => e.source === 'approved' && e.intent === 'clave')).toBe(true);
    expect((await detect('quiero cambiar mi clave')).body.intent).toBe('clave');
  });

  it('rejects an invalid definition with 400 and leaves the item pending', async () => {
    const { app, unmatched } = setup();
    const row = unmatched.seed({ maskedText: 'x' });
    const res = await request(app)
      .post(`/admin/unmatched/${row.id}/approve-new`)
      .set('Authorization', ADMIN)
      .send({ name: 'clave' }); // initialStep missing
    expect(res.status).toBe(400);
    expect(row.status).toBe('pending');
  });

  it('409 when the intent name already exists, item stays pending', async () => {
    const { app, unmatched, repository } = setup();
    await addIntent(repository, 'clave', ['clave']);
    const row = unmatched.seed({ maskedText: 'x' });
    const res = await request(app)
      .post(`/admin/unmatched/${row.id}/approve-new`)
      .set('Authorization', ADMIN)
      .send({ name: 'clave', initialStep: '/s', keywords: ['clave'] });
    expect(res.status).toBe(409);
    expect(row.status).toBe('pending');
  });

  it('404 / 409 for unknown or resolved items without creating the intent', async () => {
    const { app, unmatched, repository } = setup();
    const body = { name: 'nuevo', initialStep: '/s', keywords: ['nuevo'] };
    const unknown = await request(app)
      .post(`/admin/unmatched/${UNKNOWN_ID}/approve-new`)
      .set('Authorization', ADMIN)
      .send(body);
    expect(unknown.status).toBe(404);
    const done = unmatched.seed({ maskedText: 'x', status: 'rejected' });
    const res = await request(app).post(`/admin/unmatched/${done.id}/approve-new`).set('Authorization', ADMIN).send(body);
    expect(res.status).toBe(409);
    expect(await repository.findByName('nuevo')).toBeNull();
  });
});

describe('POST /admin/unmatched/:id/reject', () => {
  it('marks rejected without creating an example; second call is 409', async () => {
    const { app, unmatched, examples } = setup();
    const row = unmatched.seed({ maskedText: 'spam' });
    const send = () => request(app).post(`/admin/unmatched/${row.id}/reject`).set('Authorization', ADMIN).send({});
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: row.id, status: 'rejected' });
    expect(row).toMatchObject({ status: 'rejected', resolvedBy: 'admin-1' });
    expect(examples.rows).toHaveLength(0);
    expect((await send()).status).toBe(409);
  });

  it('404 for unknown and malformed ids', async () => {
    const { app } = setup();
    for (const id of [UNKNOWN_ID, 'nope']) {
      const res = await request(app).post(`/admin/unmatched/${id}/reject`).set('Authorization', ADMIN).send({});
      expect(res.status).toBe(404);
    }
  });
});

describe('POST /admin/intent-examples/reembed', () => {
  it('embeds the pending examples and reports counts', async () => {
    const { app, examples, embedder } = setup();
    await examples.upsertMany([
      { intent: 'saldo', text: 'a', textHash: 'h1', source: 'approved' },
      { intent: 'saldo', text: 'b', textHash: 'h2', source: 'approved' },
    ]);
    embedder.failWith = null;
    const res = await request(app).post('/admin/intent-examples/reembed').set('Authorization', ADMIN).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ embedded: 2, failed: 0 });
    expect(examples.rows.every((r) => r.embedding !== null)).toBe(true);
  });
});

describe('admin review without semantic services', () => {
  it('list and reject work; approve / approve-new / reembed answer 503', async () => {
    const unmatched = new InMemoryUnmatchedMessageRepository();
    const repository = new InMemoryIntentRepository();
    await addIntent(repository, 'saldo', ['saldo']);
    const app = createApp({ repository, config, unmatched });
    const row = unmatched.seed({ maskedText: 'x' });
    const as = (path: string, body: object = {}) => request(app).post(path).set('Authorization', ADMIN).send(body);

    expect((await request(app).get('/admin/unmatched').set('Authorization', ADMIN)).status).toBe(200);
    expect((await as(`/admin/unmatched/${row.id}/approve`, { intent: 'saldo' })).status).toBe(503);
    expect((await as(`/admin/unmatched/${row.id}/approve-new`, { name: 'n', initialStep: '/s' })).status).toBe(503);
    expect((await as('/admin/intent-examples/reembed')).status).toBe(503);
    expect(row.status).toBe('pending');
    expect((await as(`/admin/unmatched/${row.id}/reject`)).status).toBe(200);
  });
});
