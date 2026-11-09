import type { Embedder } from '../../domain/ports/Embedder';
import type { Unmatched, UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { runWithTimeout } from '../../infrastructure/resilience/deadline';

const PAGE = 100;

export interface PendingSnapshot {
  items: Unmatched[];
  /** True when more pending messages exist than `max`. */
  truncated: boolean;
}

/** Reads up to `max` pending messages in list order (most frequent first) by paging through `list`. */
export async function loadPendingSnapshot(
  repository: Pick<UnmatchedMessageRepository, 'list'>,
  max: number,
  since?: Date,
): Promise<PendingSnapshot> {
  const items: Unmatched[] = [];
  let after: Unmatched | undefined;
  let truncated = false;
  for (;;) {
    const page = await repository.list({
      status: 'pending',
      limit: PAGE,
      after: after && { occurrences: after.occurrences, lastSeenAt: after.lastSeenAt, id: after.id },
    });
    for (const item of page) {
      if (since && item.lastSeenAt < since) continue;
      if (items.length >= max) {
        truncated = true;
        return { items, truncated };
      }
      items.push(item);
    }
    if (page.length < PAGE) return { items, truncated };
    after = page[page.length - 1];
  }
}

/** Runs `fn` over `values` with at most `limit` in flight, keeping the order of the results. */
export async function mapLimit<T, R>(values: readonly T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/** Embeds each distinct text once. Rejects if any embedding fails (callers decide how to degrade). */
export async function embedTexts(
  embedder: Embedder,
  texts: readonly string[],
  { concurrency, timeoutMs }: { concurrency: number; timeoutMs: number },
): Promise<Map<string, number[]>> {
  const distinct = [...new Set(texts)];
  const vectors = await mapLimit(distinct, concurrency, (text) =>
    runWithTimeout(timeoutMs, (signal) => embedder.embed(text, signal)),
  );
  return new Map(distinct.map((text, index) => [text, vectors[index] as number[]]));
}
