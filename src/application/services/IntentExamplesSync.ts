import { createHash } from 'node:crypto';
import type { Intent } from '../../domain/entities/Intent';
import type { DerivedExample, IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import { normalize } from '../../domain/services/IntentDetector';
import type { EmbedPendingExamplesUseCase } from '../use-cases/EmbedPendingExamplesUseCase';

/** Keeps the derived (keyword/description) examples of an intent in step with the catalog. */
export interface IntentExamplesSync {
  sync(intent: Intent): Promise<void>;
}

export const hashText = (text: string): string => createHash('sha256').update(normalize(text)).digest('hex');

/** Catalog-authored texts (admin content, not user input) -> deduplicated examples. */
export function deriveExamples(intent: Pick<Intent, 'keywords' | 'description'>): DerivedExample[] {
  const seen = new Set<string>();
  const out: DerivedExample[] = [];
  const add = (raw: string | undefined, source: DerivedExample['source']): void => {
    const text = raw?.trim();
    if (!text) return;
    const textHash = hashText(text);
    if (seen.has(textHash)) return;
    seen.add(textHash);
    out.push({ text, textHash, source });
  };
  for (const keyword of intent.keywords) add(keyword, 'keyword');
  add(intent.description, 'description');
  return out;
}

export class IntentExamplesSyncer implements IntentExamplesSync {
  constructor(
    private readonly examples: IntentExampleRepository,
    private readonly embedPending: EmbedPendingExamplesUseCase,
  ) {}

  async sync(intent: Intent): Promise<void> {
    await this.examples.replaceDerived(intent.name, deriveExamples(intent));
    await this.embedPending.execute();
  }
}

/** Runs the sync in the background: never awaited, never fails or slows the caller. */
export function syncInBackground(sync: IntentExamplesSync | undefined, intent: Intent): void {
  if (!sync) return;
  const log = (error: unknown): void =>
    console.error('intent examples sync failed:', error instanceof Error ? error.message : 'unknown error');
  try {
    sync.sync(intent).catch(log);
  } catch (error) {
    log(error);
  }
}
