export interface DecisionOptions {
  minSimilarity: number;
  ambiguityMargin: number;
}

export type Decision =
  | { kind: 'none' }
  | { kind: 'match'; intent: string; similarity: number }
  | { kind: 'ambiguous'; intents: string[] };

/**
 * Pure copy of the ranking rule in HybridIntentClassifier.semantic(), over the best similarity per
 * intent: below the minimum -> none; a clear lead (or no runner-up) -> match; otherwise ambiguous,
 * which at runtime is settled by the LLM and therefore never counted as a match by simulations.
 */
export const decide = (best: ReadonlyMap<string, number>, { minSimilarity, ambiguityMargin }: DecisionOptions): Decision => {
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < minSimilarity) return { kind: 'none' };
  const runnerUp = ranked[1];
  if (!runnerUp || top[1] - runnerUp[1] >= ambiguityMargin) {
    return { kind: 'match', intent: top[0], similarity: top[1] };
  }
  return {
    kind: 'ambiguous',
    intents: ranked.filter(([, similarity]) => similarity >= minSimilarity && top[1] - similarity < ambiguityMargin).map(([name]) => name),
  };
};
