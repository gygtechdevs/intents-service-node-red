import { randomUUID } from 'node:crypto';
import type {
  DerivedExample,
  EmbeddedExample,
  Example,
  ExampleSource,
  IntentExampleRepository,
  NewExample,
  SimilarityHit,
} from '../../src/domain/repositories/IntentExampleRepository';

export interface StoredExample {
  id: string;
  intent: string;
  text: string;
  textHash: string;
  source: ExampleSource;
  embedding: number[] | null;
  embeddingModel: string | null;
}

const cosine = (a: number[], b: number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

export class InMemoryIntentExampleRepository implements IntentExampleRepository {
  readonly rows: StoredExample[] = [];
  searchFailure: Error | null = null;
  /** Names treated as inactive (search skips them), like the SQL join on intents.active. */
  readonly inactive = new Set<string>();

  async searchSimilar(vector: number[], k: number): Promise<SimilarityHit[]> {
    if (this.searchFailure) throw this.searchFailure;
    return this.rows
      .filter((r) => r.embedding && !this.inactive.has(r.intent))
      .map((r) => ({ intent: r.intent, similarity: cosine(vector, r.embedding as number[]) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k);
  }

  async listEmbedded(limit: number): Promise<EmbeddedExample[]> {
    return this.rows
      .filter((r) => r.embedding && !this.inactive.has(r.intent))
      .slice(0, limit)
      .map((r) => ({ intent: r.intent, text: r.text, source: r.source, embedding: r.embedding as number[] }));
  }

  async upsertMany(examples: NewExample[]): Promise<number> {
    let inserted = 0;
    for (const e of examples) {
      if (this.rows.some((r) => r.intent === e.intent && r.textHash === e.textHash)) continue;
      this.rows.push({
        id: randomUUID(),
        intent: e.intent,
        text: e.text,
        textHash: e.textHash,
        source: e.source,
        embedding: e.embedding ?? null,
        embeddingModel: e.embeddingModel ?? null,
      });
      inserted += 1;
    }
    return inserted;
  }

  async replaceDerived(intent: string, examples: DerivedExample[]): Promise<void> {
    const keep = new Set(examples.map((e) => e.textHash));
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const r = this.rows[i] as StoredExample;
      if (r.intent === intent && r.source !== 'approved' && !keep.has(r.textHash)) this.rows.splice(i, 1);
    }
    await this.upsertMany(examples.map((e) => ({ intent, ...e })));
  }

  async findPendingEmbedding(limit: number): Promise<Example[]> {
    return this.rows
      .filter((r) => r.embedding === null)
      .slice(0, limit)
      .map(({ id, intent, text, source }) => ({ id, intent, text, source }));
  }

  async setEmbedding(id: string, vector: number[], model: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) {
      row.embedding = vector;
      row.embeddingModel = model;
    }
  }
}
