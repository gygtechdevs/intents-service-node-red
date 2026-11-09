import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { assertSchema } from '../../src/infrastructure/db/pool';

const sql = readFileSync(join(__dirname, '../../sql/migrations/005_intent_examples.sql'), 'utf8');

describe('migration 005_intent_examples', () => {
  it('has up/down sections', () => {
    expect(sql.indexOf('-- migrate:up')).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf('-- migrate:down')).toBeGreaterThan(sql.indexOf('-- migrate:up'));
  });

  it('creates the vector extension idempotently', () => {
    expect(sql).toMatch(/CREATE EXTENSION IF NOT EXISTS vector/);
  });

  it('creates intent_examples with 512-dim embedding, FK cascade, checks and uniqueness', () => {
    expect(sql).toMatch(/CREATE TABLE intent_examples/);
    expect(sql).toMatch(/embedding\s+vector\(512\)/);
    expect(sql).toMatch(/REFERENCES intents\(key\) ON DELETE CASCADE/);
    expect(sql).toMatch(/source IN \('keyword', 'description', 'approved'\)/);
    expect(sql).toMatch(/UNIQUE \(intent_key, text_hash\)/);
  });

  it('indexes with HNSW cosine ops', () => {
    expect(sql).toMatch(/USING hnsw \(embedding vector_cosine_ops\)\s+WITH \(m = 16, ef_construction = 64\)/);
  });

  it('down drops the table but never the shared extension', () => {
    const down = sql.slice(sql.indexOf('-- migrate:down'));
    expect(down).toMatch(/DROP TABLE IF EXISTS intent_examples/);
    expect(down).not.toMatch(/^\s*DROP EXTENSION/m);
  });
});

describe('assertSchema with semantic', () => {
  it('does not require intent_examples by default', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await assertSchema({ query } as unknown as Pool);
    expect(((query.mock.calls[0] as unknown[][])[1] as string[][])[0]).not.toContain('intent_examples');
  });

  it('requires intent_examples when semantic is enabled', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ t: 'intent_examples', present: false }] });
    await expect(assertSchema({ query } as unknown as Pool, { semanticEnabled: true })).rejects.toThrow(
      /intent_examples/,
    );
    expect(((query.mock.calls[0] as unknown[][])[1] as string[][])[0]).toContain('intent_examples');
  });
});
