import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
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

async function setup({ semantic = true }: { semantic?: boolean } = {}) {
  const repository = new InMemoryIntentRepository();
  const unmatched = new InMemoryUnmatchedMessageRepository();
  const examples = new InMemoryIntentExampleRepository();
  const embedder = new FakeEmbedder();
  await repository.create({ name: 'password', keywords: ['reset password'], tags: [], steps: { initialStep: '/s/pw' } });
  const app = createApp({
    repository,
    config,
    unmatched,
    ...(semantic
      ? {
          unmatchedReview: {
            examples,
            embedder,
            embedModelId: 'titan',
            reembed: new EmbedPendingExamplesUseCase(examples, embedder, { modelId: 'titan' }),
          },
        }
      : {}),
  });
  return { app, repository, unmatched, examples, embedder };
}

describe('clusters and bulk routes: auth', () => {
  const routes: Array<[string, string]> = [
    ['get', '/admin/unmatched/clusters'],
    ['post', '/admin/unmatched/clusters/simulate'],
    ['post', '/admin/unmatched/bulk/approve'],
    ['post', '/admin/unmatched/bulk/reject'],
  ];

  it.each(routes)('%s %s -> 401 without a token', async (method, path) => {
    const { app } = await setup();
    expect((await (request(app) as any)[method](path).send({})).status).toBe(401);
  });

  it.each(routes)('%s %s -> 403 without ADMIN', async (method, path) => {
    const { app } = await setup();
    expect((await (request(app) as any)[method](path).set('Authorization', WRITER).send({})).status).toBe(403);
  });
});

describe('GET /admin/unmatched/clusters', () => {
  it('returns semantic clusters with masked text only', async () => {
    const { app, unmatched, embedder } = await setup();
    unmatched.seed({ maskedText: 'reset my password', occurrences: 4 });
    unmatched.seed({ maskedText: 'password reset please', occurrences: 1 });
    embedder.set('reset my password', [1, 0]).set('password reset please', [0.99, 0.1]);
    unmatched.seed({ maskedText: 'unrelated question', occurrences: 2 });
    embedder.set('unrelated question', [0, 1]);

    const res = await request(app).get('/admin/unmatched/clusters').set('Authorization', ADMIN);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ method: 'semantic', analyzed: 3, truncated: false });
    expect(res.body.clusters).toHaveLength(2);
    expect(res.body.clusters[0]).toMatchObject({ representativeText: 'reset my password', size: 5, nearestIntent: null });
    expect(res.body.clusters[0].memberIds).toHaveLength(2);
    expect(Object.keys(res.body.clusters[0]).sort()).toEqual(
      ['firstSeenAt', 'id', 'lastSeenAt', 'memberIds', 'members', 'nearestIntent', 'representativeText', 'size'].sort(),
    );
  });

  it('works without semantic services, using the lexical fallback', async () => {
    const { app, unmatched } = await setup({ semantic: false });
    unmatched.seed({ maskedText: 'reset my password' });
    unmatched.seed({ maskedText: 'reset password please' });
    const res = await request(app).get('/admin/unmatched/clusters').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.method).toBe('lexical');
    expect(res.body.clusters).toHaveLength(1);
    expect(res.body.clusters[0].nearestIntent).toMatchObject({ intent: 'password' });
  });
});

describe('POST /admin/unmatched/clusters/simulate', () => {
  it('returns an impact estimate without changing anything', async () => {
    const { app, unmatched, examples, embedder } = await setup();
    const row = unmatched.seed({ maskedText: 'i cannot log in' });
    embedder.set('i cannot log in', [1, 0]);
    const res = await request(app)
      .post('/admin/unmatched/clusters/simulate')
      .set('Authorization', ADMIN)
      .send({ intent: 'password', ids: [row.id] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent: 'password',
      days: 30,
      selected: 1,
      scope: { exact: false },
      newlyMatched: { count: 1, selected: 1 },
      regressions: { count: 0, samples: [] },
    });
    expect(row.status).toBe('pending');
    expect(examples.rows).toHaveLength(0);
  });

  it.each([
    [{ intent: 'password' }],
    [{ intent: 'password', ids: [] }],
    [{ intent: 'password', ids: [1] }],
    [{ ids: ['a'] }],
    [{ intent: '  ', ids: ['a'] }],
    [{ intent: 'password', ids: ['a'], days: 0 }],
    [{ intent: 'password', ids: ['a'], days: 366 }],
    [{ intent: 'password', ids: ['a'], days: 'x' }],
    [{ intent: 'password', ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) }],
  ])('400 for an invalid body %#', async (body) => {
    const { app } = await setup();
    const res = await request(app).post('/admin/unmatched/clusters/simulate').set('Authorization', ADMIN).send(body);
    expect(res.status).toBe(400);
  });

  it('404 for an unknown intent or when no id is pending', async () => {
    const { app, unmatched } = await setup();
    const row = unmatched.seed({ maskedText: 'x' });
    const send = (body: object) =>
      request(app).post('/admin/unmatched/clusters/simulate').set('Authorization', ADMIN).send(body);
    expect((await send({ intent: 'nope', ids: [row.id] })).status).toBe(404);
    expect((await send({ intent: 'password', ids: [UNKNOWN_ID] })).status).toBe(404);
  });

  it('503 without semantic services', async () => {
    const { app, unmatched } = await setup({ semantic: false });
    const row = unmatched.seed({ maskedText: 'x' });
    const res = await request(app)
      .post('/admin/unmatched/clusters/simulate')
      .set('Authorization', ADMIN)
      .send({ intent: 'password', ids: [row.id] });
    expect(res.status).toBe(503);
  });
});

describe('POST /admin/unmatched/bulk/approve', () => {
  it('approves every member and reports per-item results, with partial failures', async () => {
    const { app, unmatched, examples } = await setup();
    const a = unmatched.seed({ maskedText: 'one' });
    const b = unmatched.seed({ maskedText: 'two' });
    const done = unmatched.seed({ maskedText: 'three', status: 'rejected' });

    const res = await request(app)
      .post('/admin/unmatched/bulk/approve')
      .set('Authorization', ADMIN)
      .send({ intent: 'password', ids: [a.id, b.id, done.id, UNKNOWN_ID, a.id] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intent: 'password', succeeded: 2, failed: 2 });
    expect(res.body.results).toEqual([
      { id: a.id, ok: true, embedded: true },
      { id: b.id, ok: true, embedded: true },
      { id: done.id, ok: false, status: 409, error: 'Unmatched message was already resolved' },
      { id: UNKNOWN_ID, ok: false, status: 404, error: 'Unmatched message not found' },
    ]);
    expect(a).toMatchObject({ status: 'approved', resolvedIntent: 'password', resolvedBy: 'admin-1' });
    expect(examples.rows).toHaveLength(2);
  });

  it('reports 404 per item for an unknown intent and leaves the messages pending', async () => {
    const { app, unmatched } = await setup();
    const a = unmatched.seed({ maskedText: 'one' });
    const res = await request(app)
      .post('/admin/unmatched/bulk/approve')
      .set('Authorization', ADMIN)
      .send({ intent: 'nope', ids: [a.id] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 0, failed: 1 });
    expect(res.body.results[0]).toMatchObject({ ok: false, status: 404 });
    expect(a.status).toBe('pending');
  });

  it('503 without semantic services; 400 for an invalid body', async () => {
    const off = await setup({ semantic: false });
    const row = off.unmatched.seed({ maskedText: 'x' });
    const send = (app: typeof off.app, body: object) =>
      request(app).post('/admin/unmatched/bulk/approve').set('Authorization', ADMIN).send(body);
    expect((await send(off.app, { intent: 'password', ids: [row.id] })).status).toBe(503);
    const on = await setup();
    expect((await send(on.app, { ids: ['a'] })).status).toBe(400);
    expect((await send(on.app, { intent: 'password', ids: [] })).status).toBe(400);
  });
});

describe('POST /admin/unmatched/bulk/reject', () => {
  it('rejects every pending member, reporting the ones that could not be rejected', async () => {
    const { app, unmatched } = await setup({ semantic: false });
    const a = unmatched.seed({ maskedText: 'one' });
    const b = unmatched.seed({ maskedText: 'two' });
    const res = await request(app)
      .post('/admin/unmatched/bulk/reject')
      .set('Authorization', ADMIN)
      .send({ ids: [a.id, b.id, UNKNOWN_ID] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ succeeded: 2, failed: 1 });
    expect(res.body).not.toHaveProperty('intent');
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
  });

  it('400 when ids is missing', async () => {
    const { app } = await setup();
    const res = await request(app).post('/admin/unmatched/bulk/reject').set('Authorization', ADMIN).send({});
    expect(res.status).toBe(400);
  });
});
