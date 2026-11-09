import type { DetectedIntent, Intent } from '../../domain/entities/Intent';
import type { IntentClassifier } from '../../domain/ports/IntentClassifier';
import { compileCatalog, detectCompiled, type CompiledCatalog } from '../../domain/services/IntentDetector';

/** Keyword containment classifier; wraps the pure `IntentDetector` functions. */
export class KeywordIntentClassifier implements IntentClassifier {
  /**
   * Compiled form per catalog snapshot. The caching repository hands out the
   * same array until it expires, so keyword normalization runs once per
   * snapshot; an uncached repository yields a new array per call and simply
   * recompiles (the old per-message cost).
   */
  private readonly compiled = new WeakMap<readonly Intent[], CompiledCatalog>();

  async classify(text: string, catalog: readonly Intent[]): Promise<DetectedIntent | null> {
    let compiled = this.compiled.get(catalog);
    if (!compiled) {
      compiled = compileCatalog(catalog);
      this.compiled.set(catalog, compiled);
    }
    return detectCompiled(text, compiled);
  }
}
