import { randomUUID } from 'node:crypto';
import type {
  Unmatched,
  UnmatchedMessageRepository,
  UnmatchedQuery,
} from '../../src/domain/repositories/UnmatchedMessageRepository';

export interface UnmatchedRow extends Unmatched {
  textHash: string;
}

export class InMemoryUnmatchedMessageRepository implements UnmatchedMessageRepository {
  readonly rows: UnmatchedRow[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async upsert(maskedText: string, textHash: string): Promise<void> {
    const existing = this.rows.find((r) => r.textHash === textHash);
    if (existing) {
      existing.occurrences += 1;
      existing.lastSeenAt = this.now();
      return;
    }
    const at = this.now();
    this.rows.push({
      id: randomUUID(),
      maskedText,
      textHash,
      occurrences: 1,
      status: 'pending',
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedIntent: null,
      resolvedBy: null,
      resolvedAt: null,
    });
  }

  /** Test helper: adds a row with explicit values. */
  seed(partial: Partial<UnmatchedRow> & { maskedText: string }): UnmatchedRow {
    const at = this.now();
    const row: UnmatchedRow = {
      id: randomUUID(),
      textHash: randomUUID(),
      occurrences: 1,
      status: 'pending',
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedIntent: null,
      resolvedBy: null,
      resolvedAt: null,
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  async list({ status, limit, after }: UnmatchedQuery): Promise<Unmatched[]> {
    return this.rows
      .filter((r) => r.status === status && (!after || compare(r, after) > 0))
      .sort(compare)
      .slice(0, limit)
      .map(strip);
  }

  async findById(id: string): Promise<Unmatched | null> {
    const row = this.rows.find((r) => r.id === id);
    return row ? strip(row) : null;
  }

  async claim(id: string, to: 'approved' | 'rejected', by: string, intent?: string): Promise<Unmatched | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.status !== 'pending') return null;
    row.status = to;
    row.resolvedBy = by;
    row.resolvedIntent = intent ?? null;
    row.resolvedAt = this.now();
    return strip(row);
  }

  async release(id: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return;
    row.status = 'pending';
    row.resolvedBy = null;
    row.resolvedIntent = null;
    row.resolvedAt = null;
  }

  async purgeOlderThan(cutoff: Date, batch: number): Promise<number> {
    const doomed = this.rows
      .filter((r) => r.lastSeenAt < cutoff)
      .sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime())
      .slice(0, batch);
    for (const row of doomed) this.rows.splice(this.rows.indexOf(row), 1);
    return doomed.length;
  }
}

type Position = Pick<Unmatched, 'occurrences' | 'lastSeenAt' | 'id'>;

/** Total order: occurrences DESC, last_seen_at DESC, id DESC. Negative = `a` comes first. */
const compare = (a: Position, b: Position): number =>
  b.occurrences - a.occurrences ||
  b.lastSeenAt.getTime() - a.lastSeenAt.getTime() ||
  (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const strip =({ textHash: _textHash, ...rest }: UnmatchedRow): Unmatched => ({ ...rest });
