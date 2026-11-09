import type { DetectedIntent } from '../../domain/entities/Intent';
import type { IntentClassifier } from '../../domain/ports/IntentClassifier';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import { KeywordIntentClassifier } from '../services/KeywordIntentClassifier';
import type { MissRecorder } from '../services/UnmatchedRecorder';

export class DetectIntentUseCase {
  /**
   * Defaults to keyword-only classification (current behavior). When a `recorder` is supplied,
   * misses are captured fire-and-forget (never awaited, never affects the response).
   */
  constructor(
    private readonly repository: IntentRepository,
    private readonly classifier: IntentClassifier = new KeywordIntentClassifier(),
    private readonly recorder?: MissRecorder,
  ) {}

  async execute(text: string): Promise<DetectedIntent | null> {
    const catalog = await this.repository.findActive();
    const result = await this.classifier.classify(text, catalog);
    if (!result && this.recorder) this.capture(text);
    return result;
  }

  private capture(text: string): void {
    const recorder = this.recorder as MissRecorder;
    try {
      // Only the error message is logged - never the (possibly PII-bearing) text.
      recorder.record(text).catch((error: unknown) => this.logFailure(error));
    } catch (error) {
      this.logFailure(error);
    }
  }

  private logFailure(error: unknown): void {
    console.error('unmatched capture failed:', error instanceof Error ? error.message : 'unknown error');
  }
}
