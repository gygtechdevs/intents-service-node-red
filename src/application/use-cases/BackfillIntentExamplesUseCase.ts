import type { IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import { deriveExamples } from '../services/IntentExamplesSync';
import type { EmbedPendingExamplesUseCase } from './EmbedPendingExamplesUseCase';

export interface BackfillResult {
  intents: number;
  embedded: number;
  failed: number;
}

/** Idempotent: derives examples from every active intent, then embeds all rows still pending. */
export class BackfillIntentExamplesUseCase {
  constructor(
    private readonly intents: IntentRepository,
    private readonly examples: IntentExampleRepository,
    private readonly embedPending: EmbedPendingExamplesUseCase,
  ) {}

  async execute(): Promise<BackfillResult> {
    const active = await this.intents.findActive();
    for (const intent of active) {
      await this.examples.replaceDerived(intent.name, deriveExamples(intent));
    }
    const { embedded, failed } = await this.embedPending.execute();
    return { intents: active.length, embedded, failed };
  }
}
