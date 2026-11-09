import type { Request, Response } from 'express';
import { ApplicationError } from '../../../application/errors/ApplicationError';
import type { ApproveUnmatchedUseCase } from '../../../application/use-cases/ApproveUnmatchedUseCase';
import type { ListUnmatchedUseCase } from '../../../application/use-cases/ListUnmatchedUseCase';
import type { RejectUnmatchedUseCase } from '../../../application/use-cases/RejectUnmatchedUseCase';
import type { Unmatched, UnmatchedStatus } from '../../../domain/repositories/UnmatchedMessageRepository';
import { asObject, optionalString, optionalStringArray, requiredString } from './IntentsController';

const STATUSES: readonly UnmatchedStatus[] = ['pending', 'approved', 'rejected'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** Only masked text ever leaves the service. */
const toResponse = (item: Unmatched) => ({
  id: item.id,
  maskedText: item.maskedText,
  occurrences: item.occurrences,
  status: item.status,
  firstSeenAt: item.firstSeenAt,
  lastSeenAt: item.lastSeenAt,
  resolvedIntent: item.resolvedIntent,
  resolvedBy: item.resolvedBy,
  resolvedAt: item.resolvedAt,
});

const queryString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ApplicationError(`${field} must be a single value`, 400);
  return value;
};

const parseStatus = (raw: unknown): UnmatchedStatus => {
  const value = queryString(raw, 'status');
  if (value === undefined) return 'pending';
  if (!STATUSES.includes(value as UnmatchedStatus)) {
    throw new ApplicationError(`status must be one of: ${STATUSES.join(', ')}`, 400);
  }
  return value as UnmatchedStatus;
};

const parseLimit = (raw: unknown): number => {
  const value = queryString(raw, 'limit');
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > MAX_LIMIT) {
    throw new ApplicationError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }
  return n;
};

const idOf = (req: Request): string => String(req.params.id);
const subOf = (req: Request): string => req.auth?.sub ?? 'unknown';

export interface Reembedder {
  execute(): Promise<{ embedded: number; failed: number }>;
}

/**
 * HITL review of unmatched messages. `approve` / `reembed` need the semantic services; without them
 * (SEMANTIC_ENABLED=false) those endpoints answer 503 while list and reject keep working.
 */
export class UnmatchedController {
  constructor(
    private readonly listUnmatched: ListUnmatchedUseCase,
    private readonly rejectUnmatched: RejectUnmatchedUseCase,
    private readonly approveUnmatched?: ApproveUnmatchedUseCase,
    private readonly reembedder?: Reembedder,
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const { items, nextCursor } = await this.listUnmatched.execute({
      status: parseStatus(req.query.status),
      limit: parseLimit(req.query.limit),
      cursor: queryString(req.query.cursor, 'cursor'),
    });
    res.status(200).json({ items: items.map(toResponse), nextCursor });
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    const approver = this.requireSemantic(this.approveUnmatched);
    const intent = requiredString(asObject(req.body).intent, 'intent');
    const result = await approver.approveExisting(idOf(req), intent.trim(), subOf(req));
    res.status(200).json({ id: result.id, status: 'approved', intent: result.intent, embedded: result.embedded });
  };

  approveNew = async (req: Request, res: Response): Promise<void> => {
    const approver = this.requireSemantic(this.approveUnmatched);
    const body = asObject(req.body);
    const result = await approver.approveNew(
      idOf(req),
      {
        name: requiredString(body.name, 'name'),
        keywords: optionalStringArray(body.keywords, 'keywords') ?? [],
        tags: optionalStringArray(body.tags, 'tags'),
        initialStep: requiredString(body.initialStep, 'initialStep'),
        description: optionalString(body.description, 'description'),
      },
      subOf(req),
    );
    res.status(200).json({ id: result.id, status: 'approved', intent: result.intent, embedded: result.embedded });
  };

  reject = async (req: Request, res: Response): Promise<void> => {
    await this.rejectUnmatched.execute(idOf(req), subOf(req));
    res.status(200).json({ id: idOf(req), status: 'rejected' });
  };

  reembed = async (_req: Request, res: Response): Promise<void> => {
    const result = await this.requireSemantic(this.reembedder).execute();
    res.status(200).json(result);
  };

  private requireSemantic<T>(service: T | undefined): T {
    if (!service) throw new ApplicationError('Semantic matching is not enabled', 503);
    return service;
  }
}
