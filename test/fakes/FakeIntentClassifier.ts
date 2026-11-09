import type { DetectedIntent, Intent } from '../../src/domain/entities/Intent';
import type { IntentClassifier } from '../../src/domain/ports/IntentClassifier';

/** Returns a canned result and records the calls it received. */
export class FakeIntentClassifier implements IntentClassifier {
  readonly calls: Array<{ text: string; catalog: readonly Intent[] }> = [];

  constructor(private result: DetectedIntent | null = null) {}

  setResult(result: DetectedIntent | null): void {
    this.result = result;
  }

  async classify(text: string, catalog: readonly Intent[]): Promise<DetectedIntent | null> {
    this.calls.push({ text, catalog });
    return this.result;
  }
}
