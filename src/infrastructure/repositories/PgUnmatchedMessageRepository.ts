import type { Pool } from 'pg';
import type {
  Unmatched,
  UnmatchedMessageRepository,
  UnmatchedQuery,
  UnmatchedStatus,
} from '../../domain/repositories/UnmatchedMessageRepository';

interface UnmatchedRow {
  id: string;
  masked_text: string;
  occurrences: number;
  status: UnmatchedStatus;
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_intent: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
}

const COLUMNS = `id, masked_text, occurrences, status, first_seen_at, last_seen_at,
                 resolved_intent, resolved_by, resolved_at`;

/** JS Dates carry milliseconds; truncating keeps the cursor comparison exact against timestamptz. */
const SEEN_MS = "date_trunc('milliseconds', last_seen_at)";

const toUnmatched =(row: UnmatchedRow): Unmatched => ({
  id: row.id,
  maskedText: row.masked_text,
  occurrences: row.occurrences,
  status: row.status,
  firstSeenAt: row.first_seen_at,
  lastSeenAt: row.last_seen_at,
  resolvedIntent: row.resolved_intent,
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
});

export class PgUnmatchedMessageRepository implements UnmatchedMessageRepository {
  constructor(private readonly pool: Pool) {}

  async upsert(maskedText: string, textHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO unmatched_messages (masked_text, text_hash)
       VALUES ($1, $2)
       ON CONFLICT (text_hash) DO UPDATE
         SET occurrences = unmatched_messages.occurrences + 1,
             last_seen_at = now()`,
      [maskedText, textHash],
    );
  }

  async list({ status, limit, after }: UnmatchedQuery): Promise<Unmatched[]> {
    const params: unknown[] = [status, limit];
    let cursor = '';
    if (after) {
      params.push(after.occurrences, after.lastSeenAt, after.id);
      cursor = `AND (occurrences < $3
                 OR (occurrences = $3 AND ${SEEN_MS} < $4::timestamptz)
                 OR (occurrences = $3 AND ${SEEN_MS} = $4::timestamptz AND id < $5::uuid))`;
    }
    const result = await this.pool.query<UnmatchedRow>(
      `SELECT ${COLUMNS}
         FROM unmatched_messages
        WHERE status = $1 ${cursor}
        ORDER BY occurrences DESC, ${SEEN_MS} DESC, id DESC
        LIMIT $2`,
      params,
    );
    return result.rows.map(toUnmatched);
  }

  async findById(id: string): Promise<Unmatched | null> {
    const result = await this.pool.query<UnmatchedRow>(
      `SELECT ${COLUMNS} FROM unmatched_messages WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toUnmatched(row) : null;
  }

  async claim(id: string, to: 'approved' | 'rejected', by: string, intent?: string): Promise<Unmatched | null> {
    const result = await this.pool.query<UnmatchedRow>(
      `UPDATE unmatched_messages
          SET status = $2, resolved_by = $3, resolved_intent = $4, resolved_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING ${COLUMNS}`,
      [id, to, by, intent ?? null],
    );
    const row = result.rows[0];
    return row ? toUnmatched(row) : null;
  }

  async release(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE unmatched_messages
          SET status = 'pending', resolved_by = NULL, resolved_intent = NULL, resolved_at = NULL
        WHERE id = $1`,
      [id],
    );
  }

  async purgeOlderThan(cutoff: Date, batch: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM unmatched_messages
        WHERE id IN (
          SELECT id FROM unmatched_messages
           WHERE last_seen_at < $1
           ORDER BY last_seen_at
           LIMIT $2
        )`,
      [cutoff, batch],
    );
    return result.rowCount ?? 0;
  }
}
