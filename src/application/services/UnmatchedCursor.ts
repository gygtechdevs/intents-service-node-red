import { ApplicationError } from '../errors/ApplicationError';
import type { Unmatched, UnmatchedCursor } from '../../domain/repositories/UnmatchedMessageRepository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 256;

/** Opaque keyset cursor: base64url JSON of `{ o: occurrences, t: lastSeenAt ISO, i: id }`. */
export const encodeUnmatchedCursor = (row: Pick<Unmatched, 'occurrences' | 'lastSeenAt' | 'id'>): string =>
  Buffer.from(
    JSON.stringify({ o: row.occurrences, t: row.lastSeenAt.toISOString(), i: row.id }),
  ).toString('base64url');

const invalid = () => new ApplicationError('cursor is invalid', 400);

export const decodeUnmatchedCursor = (raw: string): UnmatchedCursor => {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { o, t, i } = parsed as Record<string, unknown>;
  if (typeof o !== 'number' || !Number.isSafeInteger(o) || o < 0) throw invalid();
  if (typeof t !== 'string' || typeof i !== 'string' || !UUID.test(i)) throw invalid();
  const lastSeenAt = new Date(t);
  if (Number.isNaN(lastSeenAt.getTime()) || lastSeenAt.toISOString() !== t) throw invalid();
  return { occurrences: o, lastSeenAt, id: i };
};
