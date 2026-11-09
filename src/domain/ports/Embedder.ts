/** Turns (already PII-masked) text into a fixed-size embedding vector. */
export interface Embedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

/** Alias matching the "EmbeddingProvider" naming used in the slice brief. */
export type EmbeddingProvider = Embedder;

export const EMBEDDING_DIMENSIONS = 512;
