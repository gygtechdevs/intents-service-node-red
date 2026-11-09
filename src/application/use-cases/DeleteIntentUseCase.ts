import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import { ApplicationError } from '../errors/ApplicationError';

/** Soft delete: `active=false`. The row stays because flows reference its id. */
export class DeleteIntentUseCase {
  constructor(private readonly repository: IntentRepository) {}

  async execute(name: string): Promise<void> {
    const existing = await this.repository.findByName(name);
    if (!existing?.active) {
      throw new ApplicationError(`Intent "${name}" does not exist`, 404);
    }
    await this.repository.save({ ...existing, active: false });
  }
}
