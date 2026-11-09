import type { Intent } from '../../domain/entities/Intent';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';

export interface ListIntentsFilter {
  /** Case-insensitive exact tag match. Blank means no filtering. */
  tag?: string | undefined;
}

export class ListIntentsUseCase {
  constructor(private readonly repository: IntentRepository) {}

  async execute(filter: ListIntentsFilter = {}): Promise<Intent[]> {
    const intents = await this.repository.findActive();
    const tag = filter.tag?.trim().toLowerCase();
    if (!tag) return intents;
    return intents.filter((intent) => intent.tags.some((candidate) => candidate.toLowerCase() === tag));
  }
}
