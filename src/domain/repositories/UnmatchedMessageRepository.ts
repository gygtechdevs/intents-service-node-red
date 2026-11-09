export type UnmatchedStatus = 'pending' | 'approved' | 'rejected';

/** A reviewed-or-pending miss. `maskedText` is the only text that ever exists in this service. */
export interface Unmatched {
  id: string;
  maskedText: string;
  occurrences: number;
  status: UnmatchedStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedIntent: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
}

/**
 * Position of a row in the list order (occurrences DESC, last_seen_at DESC, id DESC). `lastSeenAt`
 * has millisecond precision: adapters must compare at that precision so paging stays gap-free.
 */
export interface UnmatchedCursor {
  occurrences: number;
  lastSeenAt: Date;
  id: string;
}

export interface UnmatchedQuery {
  status: UnmatchedStatus;
  limit: number;
  /** Keyset: only rows strictly after this position in the list order. */
  after?: UnmatchedCursor | undefined;
}

/**
 * Store of messages the classifier could not match. Privacy: only PII-masked, length-capped text
 * is ever passed in (see PiiMasker); `textHash` is the sha256 of the normalized masked text.
 */
export interface UnmatchedMessageRepository {
  /** Inserts a new pending row, or bumps `occurrences`/`last_seen_at` of the existing one. */
  upsert(maskedText: string, textHash: string): Promise<void>;
  /** Rows of one status in a total order: occurrences DESC, last_seen_at DESC, id DESC. */
  list(query: UnmatchedQuery): Promise<Unmatched[]>;
  findById(id: string): Promise<Unmatched | null>;
  /**
   * Atomically moves a PENDING row to `to`. Returns the updated row, or null when the row does not
   * exist or is no longer pending (conditional update: only one concurrent caller wins).
   */
  claim(id: string, to: 'approved' | 'rejected', by: string, intent?: string): Promise<Unmatched | null>;
  /** Compensation for a failed approval: puts the row back to pending and clears the resolution. */
  release(id: string): Promise<void>;
  /** Deletes up to `batch` rows last seen before `cutoff`. Returns how many were deleted. */
  purgeOlderThan(cutoff: Date, batch: number): Promise<number>;
}
