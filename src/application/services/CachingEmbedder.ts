import type { Embedder } from '../../domain/ports/Embedder';

/**
 * Remembers embeddings by (masked) text so clustering and simulation do not pay Bedrock for the same
 * message twice. Bounded (oldest entry evicted first); failures are never cached.
 */
export class CachingEmbedder implements Embedder {
  private readonly cache = new Map<string, number[]>();

  constructor(
    private readonly inner: Embedder,
    private readonly maxEntries = 2000,
  ) {}

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const vector = await this.inner.embed(text, signal);
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(text, vector);
    return vector;
  }
}
