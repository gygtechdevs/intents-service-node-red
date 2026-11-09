import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { assertSchema } from '../../src/infrastructure/db/pool';

const sql = readFileSync(join(__dirname, '../../sql/migrations/004_unmatched_messages.sql'), 'utf8');

describe('migration 004_unmatched_messages', () => {
  it('has up/down sections and a privacy header', () => {
    expect(sql).toMatch(/^-- PRIVACY CHANGE/m);
    expect(sql).toMatch(/003/);
    expect(sql.indexOf('-- migrate:up')).toBeGreaterThan(0);
    expect(sql.indexOf('-- migrate:down')).toBeGreaterThan(sql.indexOf('-- migrate:up'));
  });

  it('creates the table with dedup hash, status and length constraints', () => {
    expect(sql).toMatch(/CREATE TABLE unmatched_messages/);
    expect(sql).toMatch(/text_hash\s+char\(64\)\s+NOT NULL UNIQUE/);
    expect(sql).toMatch(/status IN \('pending', 'approved', 'rejected'\)/);
    expect(sql).toMatch(/char_length\(masked_text\) <= 500/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS unmatched_messages/);
  });
});

describe('assertSchema', () => {
  it('validates unmatched_messages as an owned table', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ t: 'unmatched_messages', present: false }] });
    await expect(assertSchema({ query } as unknown as Pool)).rejects.toThrow(/unmatched_messages/);
    expect(((query.mock.calls[0] as unknown[][])[1] as string[][])[0]).toContain('unmatched_messages');
  });
});
