import type { UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;

export interface PurgeOptions {
  retentionDays: number;
  /** Injectable clock. */
  now?: () => Date;
  batchSize?: number;
}

/**
 * Deletes unmatched messages not seen for `retentionDays` (every status), in bounded batches.
 * Idempotent and safe to run concurrently from several replicas: the cutoff is absolute and each
 * batch only removes rows that are already expired.
 */
export class PurgeUnmatchedUseCase {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly repository: Pick<UnmatchedMessageRepository, 'purgeOlderThan'>,
    private readonly options: PurgeOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Returns the total number of rows deleted. */
  async execute(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - this.options.retentionDays * DAY_MS);
    let total = 0;
    for (;;) {
      const deleted = await this.repository.purgeOlderThan(cutoff, this.batchSize);
      total += deleted;
      if (deleted < this.batchSize) return total;
    }
  }
}
