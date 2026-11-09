import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PgIntentExampleRepository } from '../../src/infrastructure/repositories/PgIntentExampleRepository';

const make = (rows: unknown[] = [], rowCount = 0) => {
  const query = vi.fn().mockResolvedValue({ rows, rowCount });
  return { query, repo: new PgIntentExampleRepository({ query } as unknown as Pool) };
};

describe('PgIntentExampleRepository', () => {
  it('searchSimilar uses cosine distance, active intents, parametrized vector and limit', async () => {
    const { query, repo } = make([
      { intent: 'a', similarity: '0.91' },
      { intent: 'b', similarity: 0.5 },
    ]);
    const hits = await repo.searchSimilar([0.1, 0.2], 5);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/<=>/);
    expect(sql).toMatch(/i\.active/);
    expect(sql).toMatch(/embedding IS NOT NULL/);
    expect(sql).not.toContain('0.1');
    expect(params).toEqual(['[0.1,0.2]', 5]);
    expect(hits).toEqual([
      { intent: 'a', similarity: 0.91 },
      { intent: 'b', similarity: 0.5 },
    ]);
  });

  it('listEmbedded reads embedded examples of active intents with a bound limit and parses vectors', async () => {
    const { query, repo } = make([{ intent: 'a', text: 'hello', source: 'approved', embedding: '[0.1,0.2]' }]);
    const rows = await repo.listEmbedded(50);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/i\.active/);
    expect(sql).toMatch(/embedding IS NOT NULL/);
    expect(params).toEqual([50]);
    expect(rows).toEqual([{ intent: 'a', text: 'hello', source: 'approved', embedding: [0.1, 0.2] }]);
  });

  it('upsertMany inserts with ON CONFLICT DO NOTHING, values as params, and counts rows', async () => {
    const { query, repo } = make([], 2);
    const n = await repo.upsertMany([
      { intent: 'saldo', text: 'mi saldo', textHash: 'h1', source: 'keyword' },
      {
        intent: 'saldo',
        text: 'cuanto tengo',
        textHash: 'h2',
        source: 'approved',
        embedding: [1, 0],
        embeddingModel: 'm',
      },
    ]);
    expect(n).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(intent_key, text_hash\) DO NOTHING/);
    expect(sql).not.toContain('cuanto tengo');
    expect(params).toContain('cuanto tengo');
    expect(params).toContain('[1,0]');
  });

  it('upsertMany with no examples does not query', async () => {
    const { query, repo } = make();
    expect(await repo.upsertMany([])).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('replaceDerived deletes stale derived rows (never approved) then inserts the new ones', async () => {
    const { query, repo } = make();
    await repo.replaceDerived('saldo', [{ text: 'saldo', textHash: 'h1', source: 'keyword' }]);
    const [delSql, delParams] = query.mock.calls[0] as [string, unknown[]];
    expect(delSql).toMatch(/DELETE FROM intent_examples/);
    expect(delSql).toMatch(/source IN \('keyword', 'description'\)/);
    expect(delParams).toEqual(['saldo', ['h1']]);
    const [insSql] = query.mock.calls[1] as [string, unknown[]];
    expect(insSql).toMatch(/INSERT INTO intent_examples/);
  });

  it('findPendingEmbedding selects NULL embeddings', async () => {
    const { query, repo } = make([{ id: '1', intent_key: 'a', text: 't', source: 'keyword' }]);
    const rows = await repo.findPendingEmbedding(10);
    expect((query.mock.calls[0] as [string, unknown[]])[0]).toMatch(/embedding IS NULL/);
    expect(rows).toEqual([{ id: '1', intent: 'a', text: 't', source: 'keyword' }]);
  });

  it('setEmbedding updates vector and model with params', async () => {
    const { query, repo } = make();
    await repo.setEmbedding('id1', [0.5, 0.5], 'titan');
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE intent_examples/);
    expect(params).toEqual(['[0.5,0.5]', 'titan', 'id1']);
  });
});
