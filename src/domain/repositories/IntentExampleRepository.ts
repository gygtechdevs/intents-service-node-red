export type ExampleSource = 'keyword' | 'description' | 'approved';

export interface NewExample {
  intent: string;
  text: string;
  /** sha256 of the normalized text; unique per intent. */
  textHash: string;
  source: ExampleSource;
  /** Absent/null = pending embedding. */
  embedding?: number[] | null;
  embeddingModel?: string | null;
}

export interface Example {
  id: string;
  intent: string;
  text: string;
  source: ExampleSource;
}

export interface SimilarityHit {
  intent: string;
  similarity: number;
}

export interface DerivedExample {
  text: string;
  textHash: string;
  source: 'keyword' | 'description';
}

/** An embedded example of an ACTIVE intent, as read back for read-only simulations. */
export interface EmbeddedExample {
  intent: string;
  text: string;
  source: ExampleSource;
  embedding: number[];
}

/** Few-shot examples per intent with their embeddings (pgvector in production). */
export interface IntentExampleRepository {
  /** Up to `limit` embedded examples of ACTIVE intents (read-only; used by impact simulation). */
  listEmbedded(limit: number): Promise<EmbeddedExample[]>;
  /** Top-k nearest examples of ACTIVE intents (cosine similarity, higher is closer). */
  searchSimilar(vector: number[], k: number): Promise<SimilarityHit[]>;
  /** Inserts examples, ignoring (intent, textHash) duplicates. Returns the number inserted. */
  upsertMany(examples: NewExample[]): Promise<number>;
  /** Makes the keyword/description-derived examples of an intent equal to `examples`; approved ones are untouched. */
  replaceDerived(intent: string, examples: DerivedExample[]): Promise<void>;
  /** Examples whose embedding is still NULL. */
  findPendingEmbedding(limit: number): Promise<Example[]>;
  setEmbedding(id: string, vector: number[], model: string): Promise<void>;
}
