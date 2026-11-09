import type { Embedder } from '../../domain/ports/Embedder';
import type { EmbeddedExample, IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import type { Unmatched, UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { ApplicationError } from '../errors/ApplicationError';
import { embedTexts, loadPendingSnapshot, mapLimit } from '../services/pendingSnapshot';
import { decide } from '../services/semanticDecision';
import { cosine } from '../services/textSimilarity';
import { UUID } from './unmatchedReview';

export interface SimulationOptions {
  minSimilarity: number;
  ambiguityMargin: number;
  topK: number;
  /** Max pending messages replayed (the most frequent ones). */
  replayCap?: number;
  /** Max stored examples checked for regressions. */
  exampleCap?: number;
  sampleCap?: number;
  embedTimeoutMs?: number;
  concurrency?: number;
}

export interface SimulateDeps {
  unmatched: Pick<UnmatchedMessageRepository, 'list' | 'findById'>;
  intents: Pick<IntentRepository, 'findByName'>;
  examples: Pick<IntentExampleRepository, 'searchSimilar' | 'listEmbedded'>;
  embedder: Embedder;
  options: SimulationOptions;
  now?: () => Date;
}

export interface SimulateInput {
  intent: string;
  /** Pending messages that would be approved as examples of `intent`. */
  ids: string[];
  /** History window in days for the pending messages that are replayed. */
  days: number;
}

export interface NewlyMatchedSample {
  id: string;
  maskedText: string;
  similarity: number;
  occurrences: number;
  selected: boolean;
}

export interface RegressionSample {
  maskedText: string;
  /** The intent the text resolves to today. */
  from: string;
  /** Its similarity to the new examples. */
  similarity: number;
  /** `unmatched`: a pending message; otherwise the stored example's source. */
  source: 'unmatched' | 'keyword' | 'description' | 'approved';
}

export interface ImpactResult {
  intent: string;
  days: number;
  selected: number;
  scope: {
    /** Always false: this is an estimate, never an exact replay. */
    exact: false;
    basis: 'pending-messages-and-stored-examples';
    replayedMessages: number;
    replayTruncated: boolean;
    examplesChecked: number;
    examplesTruncated: boolean;
    minSimilarity: number;
    ambiguityMargin: number;
  };
  newlyMatched: {
    count: number;
    selected: number;
    others: number;
    occurrences: number;
    samples: NewlyMatchedSample[];
  };
  /** Replayed messages that would end up ambiguous (the LLM decides at runtime); not counted as matches. */
  ambiguous: number;
  regressions: { count: number; samples: RegressionSample[] };
}

const DEFAULTS = { replayCap: 300, exampleCap: 2000, sampleCap: 10, embedTimeoutMs: 2000, concurrency: 5 };

const bestPerIntent = (hits: ReadonlyArray<{ intent: string; similarity: number }>): Map<string, number> => {
  const best = new Map<string, number>();
  for (const hit of hits) best.set(hit.intent, Math.max(best.get(hit.intent) ?? -Infinity, hit.similarity));
  return best;
};

const maxSimilarity = (vector: number[], others: number[][]): number =>
  others.reduce((max, other) => Math.max(max, cosine(vector, other)), -Infinity);

/**
 * Dry run of approving `ids` as examples of `intent`: it never writes anything.
 *
 * Honest scope: the stores keep no per-message history of what was routed (events carry no text), so
 * this is an ESTIMATE built from (a) the pending unmatched messages seen in the last `days` days and
 * (b) the stored, embedded examples of the other intents, which stand in for real traffic.
 * The hypothetical state is "today's example set plus the selected texts as examples of `intent`",
 * judged with the same similarity rule as the live classifier (keyword matches and the LLM
 * disambiguation step are not simulated).
 */
export class SimulateImpactUseCase {
  private readonly options: Required<SimulationOptions>;
  private readonly now: () => Date;

  constructor(private readonly deps: SimulateDeps) {
    this.options = { ...DEFAULTS, ...deps.options };
    this.now = deps.now ?? (() => new Date());
  }

  async execute({ intent, ids, days }: SimulateInput): Promise<ImpactResult> {
    const target = await this.deps.intents.findByName(intent);
    if (!target?.active) throw new ApplicationError(`Intent "${intent}" not found`, 404);

    const selected = await this.loadSelected(ids);
    if (selected.length === 0) throw new ApplicationError('None of the selected messages is pending', 404);

    const since = new Date(this.now().getTime() - days * 86_400_000);
    const snapshot = await loadPendingSnapshot(this.deps.unmatched, this.options.replayCap, since);
    const selectedIds = new Set(selected.map((item) => item.id));
    const replay = [...selected, ...snapshot.items.filter((item) => !selectedIds.has(item.id))];

    const embedOptions = { concurrency: this.options.concurrency, timeoutMs: this.options.embedTimeoutMs };
    let vectors: Map<string, number[]>;
    try {
      vectors = await embedTexts(this.deps.embedder, replay.map((item) => item.maskedText), embedOptions);
    } catch (error) {
      console.error('simulate: embedding failed:', error instanceof Error ? error.message : 'unknown error');
      throw new ApplicationError('Embedding service unavailable: cannot simulate', 503);
    }
    const newVectors = selected.map((item) => vectors.get(item.maskedText) as number[]);

    const { sampleCap } = this.options;
    const decisionOptions = { minSimilarity: this.options.minSimilarity, ambiguityMargin: this.options.ambiguityMargin };
    const newly: NewlyMatchedSample[] = [];
    const regressionSamples: RegressionSample[] = [];
    let newlyCount = 0;
    let newlyOccurrences = 0;
    let newlySelected = 0;
    let ambiguous = 0;
    let regressionCount = 0;

    const lookups = await mapLimit(replay, this.options.concurrency, (item) =>
      this.deps.examples.searchSimilar(vectors.get(item.maskedText) as number[], this.options.topK),
    );
    replay.forEach((item, index) => {
      const vector = vectors.get(item.maskedText) as number[];
      const current = bestPerIntent(lookups[index] ?? []);
      const before = decide(current, decisionOptions);
      const newSimilarity = maxSimilarity(vector, newVectors);
      const hypothetical = new Map(current).set(intent, Math.max(current.get(intent) ?? -Infinity, newSimilarity));
      const after = decide(hypothetical, decisionOptions);

      if (after.kind === 'ambiguous' && after.intents.includes(intent)) ambiguous += 1;
      if (after.kind !== 'match' || after.intent !== intent) return;
      if (before.kind === 'match' && before.intent === intent) return;
      if (before.kind === 'match') {
        regressionCount += 1;
        if (regressionSamples.length < sampleCap) {
          regressionSamples.push({ maskedText: item.maskedText, from: before.intent, similarity: newSimilarity, source: 'unmatched' });
        }
        return;
      }
      const isSelected = selectedIds.has(item.id);
      newlyCount += 1;
      newlyOccurrences += item.occurrences;
      if (isSelected) newlySelected += 1;
      if (newly.length < sampleCap) {
        newly.push({ id: item.id, maskedText: item.maskedText, similarity: newSimilarity, occurrences: item.occurrences, selected: isSelected });
      }
    });

    const stored = await this.deps.examples.listEmbedded(this.options.exampleCap);
    const regressions = this.exampleRegressions(stored, intent, newVectors, decisionOptions);
    regressionCount += regressions.count;
    for (const sample of regressions.samples) {
      if (regressionSamples.length < sampleCap) regressionSamples.push(sample);
    }

    return {
      intent,
      days,
      selected: selected.length,
      scope: {
        exact: false,
        basis: 'pending-messages-and-stored-examples',
        replayedMessages: replay.length,
        replayTruncated: snapshot.truncated,
        examplesChecked: stored.length,
        examplesTruncated: stored.length >= this.options.exampleCap,
        minSimilarity: this.options.minSimilarity,
        ambiguityMargin: this.options.ambiguityMargin,
      },
      newlyMatched: {
        count: newlyCount,
        selected: newlySelected,
        others: newlyCount - newlySelected,
        occurrences: newlyOccurrences,
        samples: newly,
      },
      ambiguous,
      regressions: { count: regressionCount, samples: regressionSamples },
    };
  }

  private async loadSelected(ids: string[]): Promise<Unmatched[]> {
    const unique = [...new Set(ids)].filter((id) => UUID.test(id));
    const found = await Promise.all(unique.map((id) => this.deps.unmatched.findById(id)));
    return found.filter((item): item is Unmatched => item !== null && item.status === 'pending');
  }

  /**
   * Leave-one-out over stored examples of the OTHER intents: an example "would switch" when, judged as a
   * fresh message against every other example, it resolves to some intent today but would resolve to
   * `target` once the new examples exist.
   */
  private exampleRegressions(
    stored: EmbeddedExample[],
    target: string,
    newVectors: number[][],
    decisionOptions: { minSimilarity: number; ambiguityMargin: number },
  ): { count: number; samples: RegressionSample[] } {
    const samples: RegressionSample[] = [];
    let count = 0;
    for (const example of stored) {
      if (example.intent === target) continue;
      const newSimilarity = maxSimilarity(example.embedding, newVectors);
      if (newSimilarity < decisionOptions.minSimilarity) continue; // cannot reach the target

      const current = new Map<string, number>();
      for (const other of stored) {
        if (other === example) continue;
        const similarity = cosine(example.embedding, other.embedding);
        if (similarity > (current.get(other.intent) ?? -Infinity)) current.set(other.intent, similarity);
      }
      const before = decide(current, decisionOptions);
      if (before.kind !== 'match') continue;
      const after = decide(new Map(current).set(target, Math.max(current.get(target) ?? -Infinity, newSimilarity)), decisionOptions);
      if (after.kind !== 'match' || after.intent !== target) continue;

      count += 1;
      if (samples.length < this.options.sampleCap) {
        samples.push({ maskedText: example.text, from: before.intent, similarity: newSimilarity, source: example.source });
      }
    }
    return { count, samples };
  }
}
