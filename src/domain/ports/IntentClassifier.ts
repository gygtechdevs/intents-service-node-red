import type { DetectedIntent, Intent } from '../entities/Intent';

/** Maps a free-text message to one of the catalog intents, or null. */
export interface IntentClassifier {
  classify(text: string, catalog: readonly Intent[]): Promise<DetectedIntent | null>;
}
