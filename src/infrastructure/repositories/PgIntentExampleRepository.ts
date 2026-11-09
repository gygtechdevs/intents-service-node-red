import type { Pool } from 'pg';
import type {
  DerivedExample,
  EmbeddedExample,
  Example,
  ExampleSource,
  IntentExampleRepository,
  NewExample,
  SimilarityHit,
} from '../../domain/repositories/IntentExampleRepository';

/** pgvector text literal; always passed as a bound parameter and cast with ::vector. */
const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`;

export class PgIntentExampleRepository implements IntentExampleRepository {
  constructor(private readonly pool: Pool) {}

  async searchSimilar(vector: number[], k: number): Promise<SimilarityHit[]> {
    const result = await this.pool.query<{ intent: string; similarity: string | number }>(
      `SELECT e.intent_key AS intent, 1 - (e.embedding <=> $1::vector) AS similarity
         FROM intent_examples e
         JOIN intents i ON i.key = e.intent_key AND i.active
        WHERE e.embedding IS NOT NULL
        ORDER BY e.embedding <=> $1::vector
        LIMIT $2`,
      [toVectorLiteral(vector), k],
    );
    return result.rows.map((row) => ({ intent: row.intent, similarity: Number(row.similarity) }));
  }

  async listEmbedded(limit: number): Promise<EmbeddedExample[]> {
    const result = await this.pool.query<{ intent: string; text: string; source: ExampleSource; embedding: string }>(
      `SELECT e.intent_key AS intent, e.text, e.source, e.embedding::text AS embedding
         FROM intent_examples e
         JOIN intents i ON i.key = e.intent_key AND i.active
        WHERE e.embedding IS NOT NULL
        ORDER BY e.created_at DESC, e.id
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      intent: row.intent,
      text: row.text,
      source: row.source,
      embedding: JSON.parse(row.embedding) as number[],
    }));
  }

  async upsertMany(examples: NewExample[]): Promise<number> {
    if (examples.length === 0) return 0;
    const params: unknown[] = [];
    const tuples = examples.map((e) => {
      const base = params.length;
      params.push(
        e.intent,
        e.text,
        e.textHash,
        e.source,
        e.embedding ? toVectorLiteral(e.embedding) : null,
        e.embeddingModel ?? null,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6})`;
    });
    const result = await this.pool.query(
      `INSERT INTO intent_examples (intent_key, text, text_hash, source, embedding, embedding_model)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (intent_key, text_hash) DO NOTHING`,
      params,
    );
    return result.rowCount ?? 0;
  }

  async replaceDerived(intent: string, examples: DerivedExample[]): Promise<void> {
    await this.pool.query(
      `DELETE FROM intent_examples
        WHERE intent_key = $1
          AND source IN ('keyword', 'description')
          AND NOT (text_hash = ANY($2::text[]))`,
      [intent, examples.map((e) => e.textHash)],
    );
    await this.upsertMany(examples.map((e) => ({ intent, ...e })));
  }

  async findPendingEmbedding(limit: number): Promise<Example[]> {
    const result = await this.pool.query<{ id: string; intent_key: string; text: string; source: ExampleSource }>(
      `SELECT id, intent_key, text, source
         FROM intent_examples
        WHERE embedding IS NULL
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({ id: row.id, intent: row.intent_key, text: row.text, source: row.source }));
  }

  async setEmbedding(id: string, vector: number[], model: string): Promise<void> {
    await this.pool.query(
      `UPDATE intent_examples SET embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
      [toVectorLiteral(vector), model, id],
    );
  }
}
