import type { Request, Response } from 'express';
import { ApplicationError } from '../../../application/errors/ApplicationError';
import { MAX_BULK, type BulkReviewUnmatchedUseCase } from '../../../application/use-cases/BulkReviewUnmatchedUseCase';
import type { ClusterUnmatchedUseCase } from '../../../application/use-cases/ClusterUnmatchedUseCase';
import type { SimulateImpactUseCase } from '../../../application/use-cases/SimulateImpactUseCase';
import { asObject, requiredString } from './IntentsController';

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;

const parseIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || id === '')) {
    throw new ApplicationError('ids must be a non-empty array of strings', 400);
  }
  const unique = [...new Set(value as string[])];
  if (unique.length > MAX_BULK) throw new ApplicationError(`ids must contain at most ${MAX_BULK} items`, 400);
  return unique;
};

const parseIntent = (value: unknown): string => {
  const intent = requiredString(value, 'intent').trim();
  if (intent === '') throw new ApplicationError('intent must not be empty', 400);
  return intent;
};

const parseDays = (value: unknown): number => {
  if (value === undefined || value === null) return DEFAULT_DAYS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_DAYS) {
    throw new ApplicationError(`days must be an integer between 1 and ${MAX_DAYS}`, 400);
  }
  return value;
};

const subOf = (req: Request): string => req.auth?.sub ?? 'unknown';

/**
 * Clusters of pending unmatched messages, dry-run impact simulation and bulk review. Only masked text
 * ever leaves the service. `simulate` and bulk approve need the semantic services (503 without them).
 */
export class ClustersController {
  constructor(
    private readonly clusterUnmatched: ClusterUnmatchedUseCase,
    private readonly bulk: BulkReviewUnmatchedUseCase,
    private readonly simulateImpact?: SimulateImpactUseCase,
  ) {}

  clusters = async (_req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.clusterUnmatched.execute());
  };

  simulate = async (req: Request, res: Response): Promise<void> => {
    if (!this.simulateImpact) throw new ApplicationError('Semantic matching is not enabled', 503);
    const body = asObject(req.body);
    const result = await this.simulateImpact.execute({
      intent: parseIntent(body.intent),
      ids: parseIds(body.ids),
      days: parseDays(body.days),
    });
    res.status(200).json(result);
  };

  bulkApprove = async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    res.status(200).json(await this.bulk.approve(parseIds(body.ids), parseIntent(body.intent), subOf(req)));
  };

  bulkReject = async (req: Request, res: Response): Promise<void> => {
    res.status(200).json(await this.bulk.reject(parseIds(asObject(req.body).ids), subOf(req)));
  };
}
