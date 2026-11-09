import type { Intent } from '../../domain/entities/Intent';
import type { IntentRepository, NewIntent } from '../../domain/repositories/IntentRepository';

export interface CachedIntentRepositoryOptions {
  /** Snapshot lifetime in ms. 0 (or negative) disables caching entirely. */
  ttlMs: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  logger?: { warn: (message: string, error?: unknown) => void };
}

interface Snapshot {
  data: readonly Intent[];
  expiresAt: number;
}

const freezeSnapshot = (rows: Intent[]): readonly Intent[] =>
  Object.freeze(
    rows.map((row) =>
      Object.freeze({
        ...row,
        keywords: Object.freeze([...row.keywords]) as string[],
        tags: Object.freeze([...row.tags]) as string[],
      }),
    ),
  );

/**
 * Read-through cache for `findActive()` (the hot path of intent detection).
 *
 * - Short TTL; every write through this instance invalidates immediately.
 * - Single-flight: concurrent misses share one underlying query.
 * - Stale-on-error: if a TTL-expiry refresh fails, the expired snapshot is
 *   served (with a warning). Errors are never cached. After a write there is
 *   no stale fallback, so a failed refresh never returns pre-write data.
 * - Callers receive a frozen snapshot (same reference until it expires).
 *
 * Multi-instance caveat: invalidation is local to this process; other replicas
 * only see changes after their own TTL expires.
 */
export class CachedIntentRepository implements IntentRepository {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly logger: NonNullable<CachedIntentRepositoryOptions['logger']>;
  private snapshot: Snapshot | undefined;
  private inflight: Promise<readonly Intent[]> | undefined;
  /** Bumped on every invalidation so a refresh that raced a write is not cached. */
  private generation = 0;

  constructor(
    private readonly inner: IntentRepository,
    options: CachedIntentRepositoryOptions,
  ) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { warn: (message, error) => console.warn(message, error) };
  }

  async findActive(): Promise<Intent[]> {
    if (this.ttlMs <= 0) return this.inner.findActive();

    const current = this.snapshot;
    if (current && this.now() < current.expiresAt) return current.data as Intent[];
    if (this.inflight) return this.inflight as Promise<Intent[]>;

    const generation = this.generation;
    const promise: Promise<readonly Intent[]> = this.inner
      .findActive()
      .then(
        (rows) => {
          const data = freezeSnapshot(rows);
          if (generation === this.generation) {
            this.snapshot = { data, expiresAt: this.now() + this.ttlMs };
          }
          return data;
        },
        (error: unknown) => {
          if (current && generation === this.generation) {
            this.logger.warn('Intent catalog refresh failed; serving stale snapshot', error);
            return current.data;
          }
          throw error;
        },
      )
      .finally(() => {
        if (this.inflight === promise) this.inflight = undefined;
      });
    this.inflight = promise;
    return promise as Promise<Intent[]>;
  }

  findByName(name: string): Promise<Intent | null> {
    return this.inner.findByName(name);
  }

  async create(data: NewIntent): Promise<Intent> {
    this.invalidate();
    try {
      return await this.inner.create(data);
    } finally {
      this.invalidate();
    }
  }

  async save(intent: Intent): Promise<Intent> {
    this.invalidate();
    try {
      return await this.inner.save(intent);
    } finally {
      this.invalidate();
    }
  }

  /** Drops the snapshot and detaches any in-flight refresh (it predates the write). */
  invalidate(): void {
    this.generation += 1;
    this.snapshot = undefined;
    this.inflight = undefined;
  }
}
