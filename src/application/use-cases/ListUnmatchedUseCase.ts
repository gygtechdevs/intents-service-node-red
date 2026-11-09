import { decodeUnmatchedCursor, encodeUnmatchedCursor } from '../services/UnmatchedCursor';
import type {
  Unmatched,
  UnmatchedMessageRepository,
  UnmatchedStatus,
} from '../../domain/repositories/UnmatchedMessageRepository';

export interface ListUnmatchedInput {
  status: UnmatchedStatus;
  limit: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string | undefined;
}

export interface ListUnmatchedResult {
  items: Unmatched[];
  /** Null on the last page. */
  nextCursor: string | null;
}

export class ListUnmatchedUseCase {
  constructor(private readonly repository: Pick<UnmatchedMessageRepository, 'list'>) {}

  async execute({ status, limit, cursor }: ListUnmatchedInput): Promise<ListUnmatchedResult> {
    const after = cursor === undefined ? undefined : decodeUnmatchedCursor(cursor);
    // One extra row tells whether another page exists, so the last page has no dangling cursor.
    const rows = await this.repository.list({ status, limit: limit + 1, after });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last ? encodeUnmatchedCursor(last) : null };
  }
}
