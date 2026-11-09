import { ApplicationError } from '../errors/ApplicationError';
import type { ApproveUnmatchedUseCase } from './ApproveUnmatchedUseCase';
import type { RejectUnmatchedUseCase } from './RejectUnmatchedUseCase';

export const MAX_BULK = 200;

export type BulkItemResult =
  | { id: string; ok: true; embedded?: boolean }
  | { id: string; ok: false; status: number; error: string };

export interface BulkResult {
  /** Present for approvals. */
  intent?: string;
  succeeded: number;
  failed: number;
  results: BulkItemResult[];
}

/**
 * Applies the single-message review logic to each id in turn. Each item is its own unit of work (the
 * conditional claim of the single approve/reject), so a failure never undoes the others: the caller gets
 * a per-item report (partial results) instead of an all-or-nothing transaction.
 */
export class BulkReviewUnmatchedUseCase {
  constructor(
    private readonly approver: Pick<ApproveUnmatchedUseCase, 'approveExisting'> | undefined,
    private readonly rejecter: Pick<RejectUnmatchedUseCase, 'execute'>,
  ) {}

  async approve(ids: string[], intent: string, by: string): Promise<BulkResult> {
    const approver = this.approver;
    if (!approver) throw new ApplicationError('Semantic matching is not enabled', 503);
    const results = await this.each(ids, async (id) => {
      const result = await approver.approveExisting(id, intent, by);
      return { id, ok: true as const, embedded: result.embedded };
    });
    return { intent, ...summarize(results) };
  }

  async reject(ids: string[], by: string): Promise<BulkResult> {
    const results = await this.each(ids, async (id) => {
      await this.rejecter.execute(id, by);
      return { id, ok: true as const };
    });
    return summarize(results);
  }

  private async each(ids: string[], run: (id: string) => Promise<BulkItemResult>): Promise<BulkItemResult[]> {
    const results: BulkItemResult[] = [];
    for (const id of new Set(ids)) {
      try {
        results.push(await run(id));
      } catch (error) {
        if (error instanceof ApplicationError) {
          results.push({ id, ok: false, status: error.statusCode, error: error.message });
        } else {
          console.error('bulk review: unexpected failure:', error instanceof Error ? error.message : 'unknown error');
          results.push({ id, ok: false, status: 500, error: 'Unexpected error' });
        }
      }
    }
    return results;
  }
}

const summarize = (results: BulkItemResult[]) => {
  const succeeded = results.filter((r) => r.ok).length;
  return { succeeded, failed: results.length - succeeded, results };
};
