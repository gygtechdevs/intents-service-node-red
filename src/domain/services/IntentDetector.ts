import type { DetectableIntent, DetectedIntent } from '../entities/Intent';

/**
 * Ported from the api-gateway (`domain/intent/IntentDetector.ts`) without
 * behavior changes: lowercase, strip diacritics, collapse whitespace, then a
 * keyword containment match. Highest number of matched keywords wins (stable on
 * ties); confidence is `min(1, matches / 3)`.
 *
 * Keyword normalization is hoisted into `compileCatalog`, which runs once per
 * catalog snapshot; `detectCompiled` only normalizes the incoming message.
 */
export function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CompiledIntent {
  readonly name: string;
  readonly initialStep: string;
  readonly tags: string[];
  /** Normalized, non-empty; duplicates are kept (they count as separate matches). */
  readonly keywords: readonly string[];
}

export type CompiledCatalog = readonly CompiledIntent[];

export function compileCatalog(catalog: readonly DetectableIntent[]): CompiledCatalog {
  return catalog.map((item) => ({
    name: item.name,
    initialStep: item.initialStep,
    tags: Array.isArray(item.tags) ? item.tags : [],
    keywords: (Array.isArray(item.keywords) ? item.keywords : []).map((keyword) => normalize(keyword)).filter(Boolean),
  }));
}

export function detectCompiled(messageText: string, catalog: CompiledCatalog): DetectedIntent | null {
  const message = normalize(messageText);

  if (!message) {
    return null;
  }

  const scored = catalog
    .map((item) => {
      const matchedKeywords = item.keywords.filter((keyword) => message.includes(keyword));

      return {
        intent: item.name,
        initialStep: item.initialStep,
        tags: item.tags,
        matchedKeywords,
        score: matchedKeywords.length,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const winner = scored[0];
  if (!winner) {
    return null;
  }

  return {
    intent: winner.intent,
    initialStep: winner.initialStep,
    confidence: Math.min(1, winner.score / 3),
    matchedKeywords: winner.matchedKeywords,
    tags: winner.tags,
  };
}

export function detectIntent(
  messageText: string,
  catalog: DetectableIntent[],
): DetectedIntent | null {
  return detectCompiled(messageText, compileCatalog(catalog));
}
