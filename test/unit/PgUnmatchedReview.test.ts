import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgUnmatchedMessageRepository } from '../../src/infrastructure/repositories/PgUnmatchedMessageRepository';

const makePool = (rows: unknown[] = [], rowCount = rows.length) => {
  const query = vi.fn().mockResolvedValue({ rows, rowCount });
  return { pool: { query } as unknown as Pool, query };
};

const dbRow = {
  id: '11111111-1111-4111-8111-111111111111',
  masked_text: 'quiero [DNI]',
  occurrences: 3,
  status: 'pending',
  first_seen_at: new Date('2026-01-01T00:00:00Z'),
  last_seen_at: new Date('2026-01-02T00:00:00Z'),
  resolved_intent: null,
  resolved_by: null,
  resolved_at: null,
};

describe('PgUnmatchedMessageRepository review operations', () => {
  it('list filters by status, uses the total order and binds every value', async () => {
    const { pool, query } = makePool([dbRow]);
    const out = await new PgUnmatchedMessageRepository(pool).list({ status: 'pending', limit: 20 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "ORDER BY occurrences DESC, date_trunc('milliseconds', last_seen_at) DESC, id DESC",
    );
    expect(params).toEqual(['pending', 20]);
    expect(out[0]).toMatchObject({ id: dbRow.id, maskedText: 'quiero [DNI]', occurrences: 3, status: 'pending' });
    expect(out[0]?.lastSeenAt).toEqual(dbRow.last_seen_at);
  });

  it('list with an `after` keyset adds a parameterized comparison matching the ORDER BY', async () => {
    const { pool, query } = makePool([]);
    const lastSeenAt = new Date('2026-02-01T00:00:00.123Z');
    await new PgUnmatchedMessageRepository(pool).list({
      status: 'pending',
      limit: 20,
      after: { occurrences: 3, lastSeenAt, id: dbRow.id },
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('occurrences < $3');
    expect(sql).toContain('occurrences = $3');
    expect(sql).toContain("date_trunc('milliseconds', last_seen_at) < $4::timestamptz");
    expect(sql).toContain("date_trunc('milliseconds', last_seen_at) = $4::timestamptz");
    expect(sql).toContain('id < $5::uuid');
    expect(params).toEqual(['pending', 20, 3, lastSeenAt, dbRow.id]);
    expect(sql).not.toContain(dbRow.id);
  });

  it('list without `after` does not add the keyset clause', async () => {
    const { pool, query } = makePool([]);
    await new PgUnmatchedMessageRepository(pool).list({ status: 'approved', limit: 5 });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('$3');
    expect(params).toEqual(['approved', 5]);
  });

  it('findById returns null when absent', async () => {
    const { pool } = makePool([]);
    expect(await new PgUnmatchedMessageRepository(pool).findById(dbRow.id)).toBeNull();
  });

  it('claim is a conditional UPDATE on status = pending and returns null when nothing matched', async () => {
    const { pool, query } = makePool([]);
    const out = await new PgUnmatchedMessageRepository(pool).claim(dbRow.id, 'approved', 'u1', 'saldo');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('RETURNING');
    expect(params).toEqual([dbRow.id, 'approved', 'u1', 'saldo']);
    expect(out).toBeNull();
  });

  it('claim maps the returned row', async () => {
    const { pool } = makePool([{ ...dbRow, status: 'approved', resolved_by: 'u1', resolved_intent: 'saldo' }]);
    const out = await new PgUnmatchedMessageRepository(pool).claim(dbRow.id, 'approved', 'u1', 'saldo');
    expect(out).toMatchObject({ status: 'approved', resolvedBy: 'u1', resolvedIntent: 'saldo' });
  });

  it('release puts the row back to pending and clears the resolution', async () => {
    const { pool, query } = makePool();
    await new PgUnmatchedMessageRepository(pool).release(dbRow.id);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain('resolved_by = NULL');
    expect(params).toEqual([dbRow.id]);
  });

  it('purgeOlderThan deletes a bounded batch by last_seen_at and returns the count', async () => {
    const { pool, query } = makePool([], 7);
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const n = await new PgUnmatchedMessageRepository(pool).purgeOlderThan(cutoff, 1000);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM unmatched_messages');
    expect(sql).toContain('LIMIT $2');
    expect(params).toEqual([cutoff, 1000]);
    expect(n).toBe(7);
  });
});
