import { buildSteps, readSteps, type Intent } from '../../domain/entities/Intent';
import { DuplicateIntentError, type IntentRepository } from '../../domain/repositories/IntentRepository';
import { syncInBackground, type IntentExamplesSync } from '../services/IntentExamplesSync';
import { ApplicationError } from '../errors/ApplicationError';
import { cleanKeywords, cleanTags, validateInitialStep, validateName } from './intentValidation';

export interface CreateIntentInput {
  name: string;
  keywords: string[];
  tags?: string[] | undefined;
  initialStep: string;
  description?: string | undefined;
}

export class CreateIntentUseCase {
  constructor(
    private readonly repository: IntentRepository,
    private readonly examplesSync?: IntentExamplesSync,
  ) {}

  async execute(input: CreateIntentInput): Promise<Intent> {
    const name = validateName(input.name);
    const keywords = cleanKeywords(input.keywords);
    const tags = cleanTags(input.tags ?? []);
    const initialStep = validateInitialStep(input.initialStep);
    const description = input.description?.trim() || undefined;

    const existing = await this.repository.findByName(name);
    if (existing?.active) {
      throw new ApplicationError(`Intent "${name}" already exists`, 409);
    }

    if (existing) {
      // Soft-deleted: reactivate so flows referencing its id keep working.
      const steps = buildSteps(existing.steps, {
        initialStep,
        ...(description !== undefined ? { description } : {}),
      });
      const reactivated = await this.repository.save({
        ...existing,
        keywords,
        tags,
        steps,
        ...readSteps(steps),
        active: true,
      });
      syncInBackground(this.examplesSync, reactivated);
      return reactivated;
    }

    try {
      const created = await this.repository.create({
        name,
        keywords,
        tags,
        steps: buildSteps({}, { initialStep, ...(description !== undefined ? { description } : {}) }),
      });
      syncInBackground(this.examplesSync, created);
      return created;
    } catch (error) {
      if (error instanceof DuplicateIntentError) {
        throw new ApplicationError(`Intent "${name}" already exists`, 409);
      }
      throw error;
    }
  }
}
