import type { Request, Response } from 'express';
import { ApplicationError } from '../../../application/errors/ApplicationError';
import type { CreateIntentUseCase } from '../../../application/use-cases/CreateIntentUseCase';
import type { DeleteIntentUseCase } from '../../../application/use-cases/DeleteIntentUseCase';
import type { DetectIntentUseCase } from '../../../application/use-cases/DetectIntentUseCase';
import type { ListIntentsUseCase } from '../../../application/use-cases/ListIntentsUseCase';
import type { UpdateIntentUseCase } from '../../../application/use-cases/UpdateIntentUseCase';
import type { Intent } from '../../../domain/entities/Intent';

/** Public shape (compatible with what Platform exposed and the gateway adapter reads). */
export const toResponse = (intent: Intent) => ({
  id: intent.id,
  name: intent.name,
  keywords: intent.keywords,
  tags: intent.tags,
  initialStep: intent.initialStep,
  ...(intent.description !== undefined
    ? { description: intent.description }
    : {}),
  active: intent.active,
  updatedAt: intent.updatedAt,
});

export const asObject = (body: unknown): Record<string, unknown> =>
  body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};

export const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new ApplicationError(`${field} must be a string`, 400);
  return value;
};

export const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string')
    throw new ApplicationError(`${field} must be a string`, 400);
  return value;
};

export const optionalStringArray = (
  value: unknown,
  field: string
): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApplicationError(`${field} must be an array of strings`, 400);
  }
  return value as string[];
};

export class IntentsController {
  constructor(
    private readonly listIntents: ListIntentsUseCase,
    private readonly createIntent: CreateIntentUseCase,
    private readonly updateIntent: UpdateIntentUseCase,
    private readonly deleteIntent: DeleteIntentUseCase,
    private readonly detectIntent: DetectIntentUseCase
  ) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const tag = typeof req.query.tag === 'string' ? req.query.tag : undefined;
    const intents = await this.listIntents.execute({ tag });
    res.status(200).json(intents.map(toResponse));
  };

  create = async (req: Request, res: Response): Promise<void> => {
    const body = asObject(req.body);
    const created = await this.createIntent.execute({
      name: requiredString(body.name, 'name'),
      keywords: optionalStringArray(body.keywords, 'keywords') ?? [],
      tags: optionalStringArray(body.tags, 'tags'),
      initialStep: requiredString(body.initialStep, 'initialStep'),
      description: optionalString(body.description, 'description'),
    });
    res.status(201).json(toResponse(created));
  };

  update = async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    const body = asObject(req.body);
    if (body.name !== undefined && body.name !== name) {
      throw new ApplicationError('name is immutable', 400);
    }
    const updated = await this.updateIntent.execute(name, {
      keywords: optionalStringArray(body.keywords, 'keywords'),
      tags: optionalStringArray(body.tags, 'tags'),
      initialStep: optionalString(body.initialStep, 'initialStep'),
      description: optionalString(body.description, 'description'),
    });
    res.status(200).json(toResponse(updated));
  };

  remove = async (req: Request, res: Response): Promise<void> => {
    const name = String(req.params.name);
    await this.deleteIntent.execute(name);
    res.status(200).json({ deleted: true, name });
  };

  detect = async (req: Request, res: Response): Promise<void> => {
    const text = requiredString(asObject(req.body).text, 'text');
    const detection = await this.detectIntent.execute(text);
    res
      .status(200)
      .json(
        detection ?? {
          intent: null,
          confidence: 0,
          matchedKeywords: [],
          initialStep: null,
        }
      );
  };
}
