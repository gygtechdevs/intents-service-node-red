import { buildSteps, readSteps, type Intent } from '../../domain/entities/Intent';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import { deriveExamples, syncInBackground, type IntentExamplesSync } from '../services/IntentExamplesSync';
import { ApplicationError } from '../errors/ApplicationError';
import { cleanKeywords, cleanTags, validateInitialStep } from './intentValidation';

export interface UpdateIntentInput {
  keywords?: string[] | undefined;
  tags?: string[] | undefined;
  initialStep?: string | undefined;
  description?: string | undefined;
}

/** The intent name is the identity and never changes. */
export class UpdateIntentUseCase {
  constructor(
    private readonly repository: IntentRepository,
    private readonly examplesSync?: IntentExamplesSync,
  ) {}

  async execute(name: string, input: UpdateIntentInput): Promise<Intent> {
    const keywords = input.keywords !== undefined ? cleanKeywords(input.keywords) : undefined;
    const tags = input.tags !== undefined ? cleanTags(input.tags) : undefined;
    const initialStep = input.initialStep !== undefined ? validateInitialStep(input.initialStep) : undefined;

    const existing = await this.repository.findByName(name);
    if (!existing?.active) {
      throw new ApplicationError(`Intent "${name}" does not exist`, 404);
    }

    const steps = buildSteps(existing.steps, {
      ...(initialStep !== undefined ? { initialStep } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });

    const saved = await this.repository.save({
      ...existing,
      keywords: keywords ?? existing.keywords,
      tags: tags ?? existing.tags,
      steps,
      ...readSteps(steps),
    });

    if (this.examplesSync && derivedChanged(existing, saved)) syncInBackground(this.examplesSync, saved);
    return saved;
  }
}

/** True when the keyword/description-derived examples differ (order and case-insensitive). */
function derivedChanged(before: Intent, after: Intent): boolean {
  const hashes = (intent: Intent): string => deriveExamples(intent).map((e) => e.textHash).sort().join(',');
  return hashes(before) !== hashes(after);
}
