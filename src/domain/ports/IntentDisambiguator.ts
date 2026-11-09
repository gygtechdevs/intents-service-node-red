export interface DisambiguationCandidate {
  name: string;
  description?: string;
}

/**
 * Picks the best intent among a few candidates. Returns a candidate name, or null when
 * none fits or the answer cannot be trusted. Implementations must only ever return a
 * name contained in `candidates`.
 */
export interface IntentDisambiguator {
  choose(text: string, candidates: DisambiguationCandidate[], signal?: AbortSignal): Promise<string | null>;
}

/** Alias matching the "AmbiguityResolver" naming used in the slice brief. */
export type AmbiguityResolver = IntentDisambiguator;
