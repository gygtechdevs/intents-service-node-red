import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS, type Embedder } from '../../src/domain/ports/Embedder';

/** Deterministic unit vectors: explicit per-text vectors win, otherwise a hash-derived one. */
export class FakeEmbedder implements Embedder {
  readonly calls: string[] = [];
  failWith: Error | null = null;
  delayMs = 0;
  private readonly vectors = new Map<string, number[]>();

  set(text: string, vector: number[]): this {
    this.vectors.set(text, vector);
    return this;
  }

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith) throw this.failWith;
    return this.vectors.get(text) ?? FakeEmbedder.vectorFor(text);
  }

  /** Unit vector with a single hot dimension chosen from the hash of the text. */
  static vectorFor(text: string): number[] {
    const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    v[createHash('sha256').update(text).digest()[0]! % EMBEDDING_DIMENSIONS] = 1;
    return v;
  }
}
