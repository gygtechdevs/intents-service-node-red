import type { Embedder } from '../../domain/ports/Embedder';
import type { Example, IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';

export interface EmbedPendingOptions {
  modelId: string;
  batchSize?: number;
  concurrency?: number;
}

export interface EmbedPendingResult {
  embedded: number;
  failed: number;
}

/** Embeds examples whose embedding is NULL. Failures stay NULL for the next sweep; never throws. */
export class EmbedPendingExamplesUseCase {
  private readonly batchSize: number;
  private readonly concurrency: number;

  constructor(
    private readonly examples: IntentExampleRepository,
    private readonly embedder: Embedder,
    private readonly options: EmbedPendingOptions,
  ) {
    this.batchSize = options.batchSize ?? 50;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  async execute(): Promise<EmbedPendingResult> {
    const attempted = new Set<string>();
    let embedded = 0;
    let failed = 0;

    for (;;) {
      let pending: Example[];
      try {
        // Rows that failed stay NULL and come back first: over-fetch past them to reach the rest.
        pending = (await this.examples.findPendingEmbedding(this.batchSize + attempted.size))
          .filter((e) => !attempted.has(e.id))
          .slice(0, this.batchSize);
      } catch (error) {
        console.error('embed pending: lookup failed:', error instanceof Error ? error.message : 'unknown error');
        break;
      }
      if (pending.length === 0) break;
      pending.forEach((e) => attempted.add(e.id));

      for (let i = 0; i < pending.length; i += this.concurrency) {
        const outcomes = await Promise.all(pending.slice(i, i + this.concurrency).map((e) => this.embedOne(e)));
        for (const ok of outcomes) {
          if (ok) embedded += 1;
          else failed += 1;
        }
      }
    }
    return { embedded, failed };
  }

  private async embedOne(example: Example): Promise<boolean> {
    try {
      const vector = await this.embedder.embed(example.text);
      await this.examples.setEmbedding(example.id, vector, this.options.modelId);
      return true;
    } catch {
      return false;
    }
  }
}
