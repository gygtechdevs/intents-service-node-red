import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgMessageEventRepository } from '../../src/infrastructure/repositories/PgMessageEventRepository';
import type { NewMessageEvent } from '../../src/domain/repositories/MessageEventRepository';

const makePool = (rows: unknown[] = []) => {
  const query = vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { pool: { query } as unknown as Pool, query };
};

const range = { from: new Date('2026-05-01T00:00:00Z'), to: new Date('2026-05-08T00:00:00Z') };

const sample = (n: number): NewMessageEvent => ({
  occurredAt: new Date('2026-05-01T10:00:00Z'),
  channel: 'web',
  channelName: null,
  conversationId: String(n).padStart(64, '0'),
  intent: null,
  matched: false,
  tags: ['a'],
  routedStep: null,
  outcome: 'no_intent',
  nodeRedStatus: null,
  durationMs: 5,
});

describe('PgMessageEventRepository', () => {
  it('inserts a batch with one parameterised statement', async () => {
    const { pool, query } = makePool();
    const accepted = await new PgMessageEventRepository(pool).insertMany([sample(1), sample(2)]);
    expect(accepted).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO message_events');
    expect(params).toHaveLength(22);
    expect(sql).toContain('$22');
    expect(sql).not.toContain(sample(1).conversationId); // never inlined
  });

  it('does not touch the database for an empty batch', async () => {
    const { pool, query } = makePool();
    expect(await new PgMessageEventRepository(pool).insertMany([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('aggregates totals in SQL with a half-open range and optional channel', async () => {
    const { pool, query } = makePool([{ total: 4, conversations: 3, matched: 3, errors: 1 }]);
    const repo = new PgMessageEventRepository(pool);
    expect(await repo.totals({ ...range, channel: 'web' })).toEqual({
      totalMessages: 4,
      uniqueConversations: 3,
      matchedMessages: 3,
      errorMessages: 1,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/occurred_at >= \$1 AND occurred_at < \$2/);
    expect(params).toEqual([range.from, range.to, 'web']);
  });

  it('maps by-channel, tags, daily and intents rows', async () => {
    const repo = (rows: unknown[]) => new PgMessageEventRepository(makePool(rows).pool);
    expect(await repo([{ channel: 'web', channel_name: 'Web', messages: 2, conversations: 1 }]).byChannel(range)).toEqual([
      { channel: 'web', channelName: 'Web', messages: 2, conversations: 1 },
    ]);
    expect(await repo([{ tag: 'a', count: 2 }]).topTags(range, 3)).toEqual([{ tag: 'a', count: 2 }]);
    expect(await repo([{ day: '2026-05-01', channel: 'web', count: 2 }]).daily(range)).toEqual([
      { date: '2026-05-01', channel: 'web', count: 2 },
    ]);
    expect(await repo([{ intent: 'x', count: 5 }]).topIntents(range, 10)).toEqual([{ intent: 'x', count: 5 }]);
  });

  it('passes limit as a bound parameter', async () => {
    const { pool, query } = makePool();
    await new PgMessageEventRepository(pool).topTags(range, 3);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('LIMIT $4');
    expect(params).toEqual([range.from, range.to, null, 3]);
  });
});
