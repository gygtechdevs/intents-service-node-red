import type { Intent, IntentSteps } from '../entities/Intent';

export interface NewIntent {
  name: string;
  keywords: string[];
  tags: string[];
  steps: IntentSteps;
}

/** Raised by the repository when `intents.key` already exists (race on create). */
export class DuplicateIntentError extends Error {
  constructor(public readonly intentName: string) {
    super(`Intent "${intentName}" already exists`);
    this.name = 'DuplicateIntentError';
  }
}

export interface IntentRepository {
  /** Active intents only, ordered by name. */
  findActive(): Promise<Intent[]>;
  /** Looks up by name regardless of `active` (soft-deleted rows included). */
  findByName(name: string): Promise<Intent | null>;
  create(data: NewIntent): Promise<Intent>;
  /** Persists keywords, tags, steps and active of an existing intent; name is never changed. */
  save(intent: Intent): Promise<Intent>;
}
