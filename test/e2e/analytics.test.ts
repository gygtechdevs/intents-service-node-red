import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Express } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { InMemoryIntentRepository } from '../fakes/InMemoryIntentRepository';
import { InMemoryMessageEventRepository } from '../fakes/InMemoryMessageEventRepository';

const JWT_SECRET = 'test-jwt-secret';
const INTERNAL_SECRET = 'test-internal-secret';
const HASH = (n: number): string => n.toString(16).padStart(64, '0');

const bearer = (permissions: string[]): [string, string] => [
  'Authorization',
  `Bearer ${jwt.sign({ email: 'u@example.com', permissions }, JWT_SECRET, { algorithm: 'HS256', subject: 'u1', expiresIn: 900 })}`,
];

const event = (overrides: Record<string, unknown> = {}) => ({
  occurredAt: '2026-05-10T12:00:00.000Z',
  channel: 'whatsapp',
  channelName: 'Support line',
  conversationId: HASH(1),
  intent: 'plazo fijo',
  matched: true,
  tags: ['Inversiones'],
  routedStep: '/stepin/pf',
  outcome: 'ok',
  nodeRedStatus: 200,
  durationMs: 120,
  ...overrides,
});

describe('analytics HTTP API', () => {
  let app: Express;
  let events: InMemoryMessageEventRepository;

  beforeEach(() => {
    events = new InMemoryMessageEventRepository();
    app = createApp({
      repository: new InMemoryIntentRepository(),
      events,
      config: { jwtSecret: JWT_SECRET, internalSecret: INTERNAL_SECRET },
      now: () => new Date('2026-05-31T10:00:00.000Z'),
    });
  });

  const ingest = (batch: unknown[]) =>
    request(app).post('/internal/events').set('X-Internal-Secret', INTERNAL_SECRET).send({ events: batch });

  describe('POST /internal/events', () => {
    it('requires the internal secret', async () => {
      const res = await request(app).post('/internal/events').send({ events: [event()] });
      expect(res.status).toBe(403);
      const wrong = await request(app).post('/internal/events').set('X-Internal-Secret', 'nope').send({ events: [event()] });
      expect(wrong.status).toBe(403);
    });

    it('stores a valid batch and answers 202', async () => {
      const res = await ingest([event(), event({ channel: 'web', channelName: null, intent: null, matched: false, tags: [], outcome: 'no_intent', routedStep: null, nodeRedStatus: null })]);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ accepted: 2 });
      expect(events.events).toHaveLength(2);
      expect(events.events[0]?.occurredAt).toEqual(new Date('2026-05-10T12:00:00.000Z'));
    });

    it('defaults occurredAt to now when omitted', async () => {
      const { occurredAt: _omit, ...rest } = event();
      await ingest([rest]);
      expect(events.events[0]?.occurredAt).toEqual(new Date('2026-05-31T10:00:00.000Z'));
    });

    it('rejects more than 50 events', async () => {
      const res = await ingest(Array.from({ length: 51 }, () => event()));
      expect(res.status).toBe(400);
      expect(events.events).toHaveLength(0);
    });

    it.each([
      ['empty batch', []],
      ['unknown outcome', [event({ outcome: 'weird' })]],
      ['non-hash conversation id (possible phone number)', [event({ conversationId: '5491155551234' })]],
      ['bad channel', [event({ channel: 'Not Valid!' })]],
      ['non boolean matched', [event({ matched: 'yes' })]],
      ['too many tags', [event({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })]],
      ['bad status', [event({ nodeRedStatus: 42 })]],
      ['negative duration', [event({ durationMs: -1 })]],
      ['invalid date', [event({ occurredAt: 'yesterday' })]],
    ])('rejects the whole batch: %s', async (_label, batch) => {
      const res = await ingest(batch as unknown[]);
      expect(res.status).toBe(400);
      expect(events.events).toHaveLength(0);
    });

    it('rejects a body without events array', async () => {
      const res = await request(app).post('/internal/events').set('X-Internal-Secret', INTERNAL_SECRET).send({});
      expect(res.status).toBe(400);
    });

    it('ignores unknown fields such as message text', async () => {
      await ingest([event({ text: 'my secret message', phone: '5491155551234' })]);
      expect(JSON.stringify(events.events)).not.toContain('secret message');
      expect(JSON.stringify(events.events)).not.toContain('5491155551234');
    });
  });

  describe('read endpoints', () => {
    const seed = async () => {
      await ingest([
        event({ occurredAt: '2026-05-10T10:00:00.000Z', conversationId: HASH(1), tags: ['Inversiones', 'Ahorro'] }),
        event({ occurredAt: '2026-05-10T11:00:00.000Z', conversationId: HASH(1), tags: ['Inversiones'] }),
        event({ occurredAt: '2026-05-11T09:00:00.000Z', channel: 'web', channelName: 'Web chat', conversationId: HASH(2), intent: null, matched: false, tags: [], outcome: 'no_intent', routedStep: null }),
        event({ occurredAt: '2026-05-11T09:30:00.000Z', channel: 'web', channelName: 'Web chat', conversationId: HASH(3), outcome: 'error', nodeRedStatus: 500, tags: ['Ahorro'] }),
        // previous period (10..14 May vs 5..9 May)
        event({ occurredAt: '2026-05-06T09:30:00.000Z', conversationId: HASH(9) }),
      ]);
    };
    const range = 'from=2026-05-10&to=2026-05-14';

    it.each([
      '/analytics/summary',
      '/analytics/by-channel',
      '/analytics/top-tags',
      '/analytics/daily',
      '/analytics/top-intents',
    ])('%s requires a JWT', async (path) => {
      expect((await request(app).get(path)).status).toBe(401);
    });

    it('accepts a token with no permissions (read-only)', async () => {
      expect((await request(app).get('/analytics/summary').set(...bearer([]))).status).toBe(200);
    });

    it('GET /analytics/summary', async () => {
      await seed();
      const res = await request(app).get(`/analytics/summary?${range}`).set(...bearer(['READ']));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        totalMessages: 4,
        uniqueConversations: 3,
        matchedRate: 0.75,
        errorRate: 0.25,
        previousPeriod: { totalMessages: 1, deltaPct: 300 },
      });
    });

    it('summary: deltaPct is null when the previous period is empty, rates are 0 without data', async () => {
      const res = await request(app).get(`/analytics/summary?${range}`).set(...bearer([]));
      expect(res.body).toEqual({
        totalMessages: 0,
        uniqueConversations: 0,
        matchedRate: 0,
        errorRate: 0,
        previousPeriod: { totalMessages: 0, deltaPct: null },
      });
    });

    it('summary honours the channel filter', async () => {
      await seed();
      const res = await request(app).get(`/analytics/summary?${range}&channel=web`).set(...bearer([]));
      expect(res.body.totalMessages).toBe(2);
      expect(res.body.previousPeriod.totalMessages).toBe(0);
    });

    it('defaults to the last 30 days (UTC) when no range is given', async () => {
      await ingest([event({ occurredAt: '2026-05-02T00:00:00.000Z' }), event({ occurredAt: '2026-05-01T23:59:59.000Z' })]);
      const res = await request(app).get('/analytics/summary').set(...bearer([]));
      expect(res.body.totalMessages).toBe(1); // 2026-05-02 .. 2026-05-31 inclusive
    });

    it('GET /analytics/by-channel (ignores the channel filter)', async () => {
      await seed();
      const res = await request(app).get(`/analytics/by-channel?${range}&channel=web`).set(...bearer([]));
      expect(res.body).toEqual([
        { channel: 'web', channelName: 'Web chat', messages: 2, conversations: 2 },
        { channel: 'whatsapp', channelName: 'Support line', messages: 2, conversations: 1 },
      ]);
    });

    it('GET /analytics/top-tags with pct of messages in range', async () => {
      await seed();
      const res = await request(app).get(`/analytics/top-tags?${range}&limit=2`).set(...bearer([]));
      expect(res.body).toEqual([
        { tag: 'Ahorro', count: 2, pct: 50 },
        { tag: 'Inversiones', count: 2, pct: 50 },
      ]);
    });

    it('top-tags defaults to 3 and caps limit at 50', async () => {
      expect((await request(app).get('/analytics/top-tags?limit=0').set(...bearer([]))).status).toBe(400);
      expect((await request(app).get('/analytics/top-tags?limit=51').set(...bearer([]))).status).toBe(400);
      expect((await request(app).get('/analytics/top-tags?limit=abc').set(...bearer([]))).status).toBe(400);
    });

    it('GET /analytics/daily fills every UTC day of the range', async () => {
      await seed();
      const res = await request(app).get(`/analytics/daily?from=2026-05-10&to=2026-05-12`).set(...bearer([]));
      expect(res.body).toEqual([
        { date: '2026-05-10', byChannel: { whatsapp: 2, web: 0 }, total: 2 },
        { date: '2026-05-11', byChannel: { whatsapp: 0, web: 2 }, total: 2 },
        { date: '2026-05-12', byChannel: { whatsapp: 0, web: 0 }, total: 0 },
      ]);
    });

    it('GET /analytics/top-intents ignores unmatched messages', async () => {
      await seed();
      const res = await request(app).get(`/analytics/top-intents?${range}`).set(...bearer([]));
      expect(res.body).toEqual([{ intent: 'plazo fijo', count: 3 }]);
    });

    it.each([
      ['from=2026-05-10&to=2026-05-09', 'from after to'],
      ['from=2025-01-01&to=2026-05-01', 'more than 366 days'],
      ['from=nope&to=2026-05-01', 'malformed from'],
      ['from=2026-02-31&to=2026-03-01', 'impossible date'],
    ])('range validation: %s (%s)', async (query, _label) => {
      const res = await request(app).get(`/analytics/summary?${query}`).set(...bearer([]));
      expect(res.status).toBe(400);
    });

    it('accepts exactly 366 days', async () => {
      const res = await request(app).get('/analytics/summary?from=2025-05-01&to=2026-05-01').set(...bearer([]));
      expect(res.status).toBe(200);
    });

    it('rejects an invalid channel filter', async () => {
      const res = await request(app).get('/analytics/summary?channel=Bad%20Channel').set(...bearer([]));
      expect(res.status).toBe(400);
    });
  });
});
