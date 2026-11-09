import type { DetectedIntent, Intent } from '../../domain/entities/Intent';
import type { Embedder } from '../../domain/ports/Embedder';
import type { IntentClassifier } from '../../domain/ports/IntentClassifier';
import type { IntentDisambiguator } from '../../domain/ports/IntentDisambiguator';
import type { IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import { maskPii } from '../../domain/services/PiiMasker';
import { createDeadline, runWithTimeout } from '../../infrastructure/resilience/deadline';

export interface HybridOptions {
  /** Minimum cosine similarity for the best intent to count as a match. */
  minSimilarity: number;
  /** Best vs runner-up gap below which the LLM is asked to choose. */
  ambiguityMargin: number;
  topK: number;
  /** Overall time budget of the semantic path per message. */
  budgetMs: number;
  disambiguationEnabled: boolean;
  /** Minimum remaining budget required to attempt the LLM step (default 300). */
  minLlmRemainingMs?: number;
}

export interface HybridDeps {
  keyword: IntentClassifier;
  embedder: Embedder;
  examples: IntentExampleRepository;
  disambiguator?: IntentDisambiguator;
  options: HybridOptions;
  logger?: { error(message: string): void };
}

const DEFAULT_MIN_LLM_REMAINING_MS = 300;

/**
 * Keyword first (any hit wins, zero Bedrock cost). Only on a keyword miss: mask -> embed -> pgvector
 * top-k -> the LLM only when the best matches are within the ambiguity margin. Fail-open: any error,
 * open breaker or exhausted budget yields null (the keyword result) and never throws.
 */
export class HybridIntentClassifier implements IntentClassifier {
  private readonly logger: { error(message: string): void };

  constructor(private readonly deps: HybridDeps) {
    this.logger = deps.logger ?? { error: (message) => console.error(message) };
  }

  async classify(text: string, catalog: readonly Intent[]): Promise<DetectedIntent | null> {
    const keywordResult = await this.deps.keyword.classify(text, catalog);
    if (keywordResult) return { ...keywordResult, source: 'keyword' };

    try {
      return await this.semantic(text, catalog);
    } catch (error) {
      // Only the error message is logged - never the (possibly PII-bearing) text.
      this.logger.error(`semantic classification failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
  }

  private async semantic(text: string, catalog: readonly Intent[]): Promise<DetectedIntent | null> {
    const { embedder, examples, disambiguator, options } = this.deps;
    const masked = maskPii(text);
    if (!masked) return null;

    const deadline = createDeadline(options.budgetMs);
    const vector = await runWithTimeout(deadline.remainingMs(), (signal) => embedder.embed(masked, signal));
    const hits = await runWithTimeout(deadline.remainingMs(), () => examples.searchSimilar(vector, options.topK));

    const byName = new Map(catalog.map((intent) => [intent.name, intent]));
    const best = new Map<string, number>();
    for (const hit of hits) {
      if (!byName.has(hit.intent)) continue;
      best.set(hit.intent, Math.max(best.get(hit.intent) ?? -Infinity, hit.similarity));
    }
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (!top || top[1] < options.minSimilarity) return null;

    const runnerUp = ranked[1];
    if (!runnerUp || top[1] - runnerUp[1] >= options.ambiguityMargin) {
      return this.result(byName.get(top[0]) as Intent, top[1], 'semantic');
    }

    // Ambiguous: only the close candidates go to the LLM.
    const minRemaining = options.minLlmRemainingMs ?? DEFAULT_MIN_LLM_REMAINING_MS;
    if (!options.disambiguationEnabled || !disambiguator || deadline.remainingMs() < minRemaining) return null;

    const candidates = ranked.filter(([, similarity]) => similarity >= options.minSimilarity && top[1] - similarity < options.ambiguityMargin);
    const chosen = await runWithTimeout(deadline.remainingMs(), (signal) =>
      disambiguator.choose(
        masked,
        candidates.map(([name]) => {
          const description = byName.get(name)?.description;
          return { name, ...(description ? { description } : {}) };
        }),
        signal,
      ),
    );
    const match = candidates.find(([name]) => name === chosen);
    if (!match) return null;
    return this.result(byName.get(match[0]) as Intent, match[1], 'llm');
  }

  private result(intent: Intent, confidence: number, source: 'semantic' | 'llm'): DetectedIntent {
    return {
      intent: intent.name,
      initialStep: intent.initialStep,
      confidence,
      matchedKeywords: [],
      tags: intent.tags ?? [],
      source,
    };
  }
}
