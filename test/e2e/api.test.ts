import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';

const JWT_SECRET = 'test-jwt-secret';
const INTERNAL_SECRET = 'test-internal-secret';

const token = (permissions: string[], options: { secret?: string; expiresIn?: number } = {}): string =>
  jwt.sign({ email: 'user@example.com', permissions }, options.secret ?? JWT_SECRET, {
    algorithm: 'HS256',
    subject: 'user-1',
    expiresIn: options.expiresIn ?? 900,
  });

const bearer = (permissions: string[]): [string, string] => ['Authorization', `Bearer ${token(permissions)}`];

const body = { name: 'plazo fijo', keywords: ['plazo fijo'], initialStep: '/stepin/pf', description: 'PF' };

describe('intents-service HTTP API', () => {
  let app: Express;
  let repo: InMemoryIntentRepository;

  beforeEach(() => {
    repo = new InMemoryIntentRepository();
    app = createApp({
      repository: repo,
      config: { jwtSecret: JWT_SECRET, internalSecret: INTERNAL_SECRET },
    });
  });

  describe('GET /health', () => {
    it('is open', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });
  });

  describe('JWT rules', () => {
    it('GET /intents without token -> 401', async () => {
      expect((await request(app).get('/intents')).status).toBe(401);
    });

    it('rejects a token signed with another secret -> 401', async () => {
      const bad = token(['ADMIN'], { secret: 'other' });
      expect((await request(app).get('/intents').set('Authorization', `Bearer ${bad}`)).status).toBe(401);
    });

    it('rejects an expired token -> 401', async () => {
      const expired = token(['ADMIN'], { expiresIn: -10 });
      expect((await request(app).get('/intents').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    });

    it('rejects non-HS256 tokens -> 401', async () => {
      const hs512 = jwt.sign({ permissions: ['ADMIN'] }, JWT_SECRET, { algorithm: 'HS512', subject: 'u' });
      expect((await request(app).get('/intents').set('Authorization', `Bearer ${hs512}`)).status).toBe(401);
    });

    it('accepts the access_token cookie', async () => {
      const res = await request(app).get('/intents').set('Cookie', `access_token=${encodeURIComponent(token([]))}`);
      expect(res.status).toBe(200);
    });

    it('GET /intents with any valid token -> 200', async () => {
      const res = await request(app).get('/intents').set(...bearer([]));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /intents without WRITE -> 403', async () => {
      const res = await request(app).post('/intents').set(...bearer(['READ'])).send(body);
      expect(res.status).toBe(403);
    });

    it('PUT /intents/:name without WRITE -> 403', async () => {
      const res = await request(app).put('/intents/x').set(...bearer(['READ'])).send({ keywords: ['a'] });
      expect(res.status).toBe(403);
    });

    it('DELETE /intents/:name requires ADMIN (WRITE is not enough) -> 403', async () => {
      const res = await request(app).delete('/intents/x').set(...bearer(['WRITE']));
      expect(res.status).toBe(403);
    });

    it('DELETE /intents/:name without token -> 401', async () => {
      expect((await request(app).delete('/intents/x')).status).toBe(401);
    });
  });

  describe('CRUD', () => {
    it('creates, lists, updates and soft-deletes an intent', async () => {
      const created = await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'plazo fijo',
        keywords: ['plazo fijo'],
        initialStep: '/stepin/pf',
        description: 'PF',
        active: true,
      });
      expect(created.body.id).toEqual(expect.any(String));

      const listed = await request(app).get('/intents').set(...bearer([]));
      expect(listed.body).toHaveLength(1);

      const updated = await request(app)
        .put('/intents/plazo%20fijo')
        .set(...bearer(['WRITE']))
        .send({ keywords: ['pf', 'plazo fijo'] });
      expect(updated.status).toBe(200);
      expect(updated.body.keywords).toEqual(['pf', 'plazo fijo']);
      expect(updated.body.initialStep).toBe('/stepin/pf');

      const deleted = await request(app).delete('/intents/plazo%20fijo').set(...bearer(['ADMIN']));
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ deleted: true, name: 'plazo fijo' });
      expect(repo.items.get('plazo fijo')?.active).toBe(false);

      expect((await request(app).get('/intents').set(...bearer([]))).body).toEqual([]);
      expect((await request(app).delete('/intents/plazo%20fijo').set(...bearer(['ADMIN']))).status).toBe(404);
    });

    it('POST duplicate -> 409, invalid -> 400', async () => {
      await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
      expect((await request(app).post('/intents').set(...bearer(['WRITE'])).send(body)).status).toBe(409);
      const invalid = await request(app).post('/intents').set(...bearer(['WRITE'])).send({ name: '' });
      expect(invalid.status).toBe(400);
    });

    it('POST rejects non-string field types with 400', async () => {
      const res = await request(app)
        .post('/intents')
        .set(...bearer(['WRITE']))
        .send({ ...body, keywords: 'plazo fijo' });
      expect(res.status).toBe(400);
    });

    it('PUT unknown -> 404 and name is immutable (400 when body name differs)', async () => {
      expect(
        (await request(app).put('/intents/nope').set(...bearer(['WRITE'])).send({ keywords: ['a'] })).status,
      ).toBe(404);
      await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
      const rename = await request(app)
        .put('/intents/plazo%20fijo')
        .set(...bearer(['WRITE']))
        .send({ name: 'other', keywords: ['a'] });
      expect(rename.status).toBe(400);
      expect(repo.items.has('other')).toBe(false);
    });

    it('returns 400 on malformed JSON', async () => {
      const res = await request(app)
        .post('/intents')
        .set(...bearer(['WRITE']))
        .set('Content-Type', 'application/json')
        .send('{bad');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /intents/detect', () => {
    beforeEach(async () => {
      await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
    });

    it('requires X-Internal-Secret (JWT is not accepted)', async () => {
      expect((await request(app).post('/intents/detect').send({ text: 'plazo fijo' })).status).toBe(403);
      const withJwt = await request(app).post('/intents/detect').set(...bearer(['ADMIN'])).send({ text: 'plazo fijo' });
      expect(withJwt.status).toBe(403);
      const wrong = await request(app).post('/intents/detect').set('X-Internal-Secret', 'nope').send({ text: 'x' });
      expect(wrong.status).toBe(403);
    });

    it('returns intent, confidence, matchedKeywords and initialStep', async () => {
      const res = await request(app)
        .post('/intents/detect')
        .set('X-Internal-Secret', INTERNAL_SECRET)
        .send({ text: 'Quiero un PLAZO fijo' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        intent: 'plazo fijo',
        confidence: 1 / 3,
        matchedKeywords: ['plazo fijo'],
        initialStep: '/stepin/pf',
        tags: [],
      });
    });

    it('returns a null intent when nothing matches', async () => {
      const res = await request(app)
        .post('/intents/detect')
        .set('X-Internal-Secret', INTERNAL_SECRET)
        .send({ text: 'hola' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ intent: null, confidence: 0, matchedKeywords: [], initialStep: null });
    });

    it('returns 400 when text is missing or not a string', async () => {
      const send = (payload: unknown) =>
        request(app).post('/intents/detect').set('X-Internal-Secret', INTERNAL_SECRET).send(payload as object);
      expect((await send({})).status).toBe(400);
      expect((await send({ text: 42 })).status).toBe(400);
    });
  });

  describe('GET /internal/intents', () => {
    beforeEach(async () => {
      await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
      await request(app).post('/intents').set(...bearer(['WRITE'])).send({ ...body, name: 'old' });
      await request(app).delete('/intents/old').set(...bearer(['ADMIN']));
    });

    it('requires X-Internal-Secret', async () => {
      expect((await request(app).get('/internal/intents')).status).toBe(403);
      expect((await request(app).get('/internal/intents').set(...bearer(['ADMIN']))).status).toBe(403);
    });

    it('returns the active catalog in the platform-compatible shape', async () => {
      const res = await request(app).get('/internal/intents').set('X-Internal-Secret', INTERNAL_SECRET);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        name: 'plazo fijo',
        keywords: ['plazo fijo'],
        initialStep: '/stepin/pf',
        description: 'PF',
      });
    });
  });
  describe('tags', () => {
    it('stores tags on create/update and returns them (empty for none)', async () => {
      const plain = await request(app).post('/intents').set(...bearer(['WRITE'])).send(body);
      expect(plain.body.tags).toEqual([]);
      const tagged = await request(app)
        .post('/intents')
        .set(...bearer(['WRITE']))
        .send({ ...body, name: 'tagged', tags: ['Ventas', 'ventas', 'pf'] });
      expect(tagged.status).toBe(201);
      expect(tagged.body.tags).toEqual(['Ventas', 'pf']);
      const updated = await request(app)
        .put('/intents/tagged')
        .set(...bearer(['WRITE']))
        .send({ tags: ['soporte'] });
      expect(updated.body.tags).toEqual(['soporte']);
    });

    it('rejects invalid tags with 400', async () => {
      const bad = (tags: unknown) =>
        request(app).post('/intents').set(...bearer(['WRITE'])).send({ ...body, tags } as object);
      expect((await bad('ventas')).status).toBe(400);
      expect((await bad([1])).status).toBe(400);
      expect((await bad(['x!'])).status).toBe(400);
    });

    it('GET /intents?tag= filters the list', async () => {
      await request(app).post('/intents').set(...bearer(['WRITE'])).send({ ...body, name: 'a', tags: ['Ventas'] });
      await request(app).post('/intents').set(...bearer(['WRITE'])).send({ ...body, name: 'b' });
      const res = await request(app).get('/intents?tag=ventas').set(...bearer([]));
      expect(res.body.map((i: { name: string }) => i.name)).toEqual(['a']);
      expect((await request(app).get('/intents').set(...bearer([]))).body).toHaveLength(2);
    });

    it('detect and internal list include tags', async () => {
      await request(app).post('/intents').set(...bearer(['WRITE'])).send({ ...body, tags: ['ventas'] });
      const detected = await request(app)
        .post('/intents/detect')
        .set('X-Internal-Secret', INTERNAL_SECRET)
        .send({ text: 'plazo fijo' });
      expect(detected.body.tags).toEqual(['ventas']);
      const internal = await request(app).get('/internal/intents').set('X-Internal-Secret', INTERNAL_SECRET);
      expect(internal.body[0].tags).toEqual(['ventas']);
    });
  });
});
