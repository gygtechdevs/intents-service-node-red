import { createHash } from 'node:crypto';
import type { Embedder } from '../../domain/ports/Embedder';
import type { IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import type { Unmatched, UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { embedTexts, loadPendingSnapshot, mapLimit } from '../services/pendingSnapshot';
import { cosine, jaccard, tokenize } from '../services/textSimilarity';

export type ClusterMethod = 'semantic' | 'lexical';

export interface ClusterMember {
  id: string;
  maskedText: string;
  occurrences: number;
}

export interface UnmatchedCluster {
  /** Stable for the same set of members (hash of the sorted member ids). */
  id: string;
  representativeText: string;
  /** Sum of the members' occurrences. */
  size: number;
  memberIds: string[];
  members: ClusterMember[];
  /** Closest existing intent to the representative message; null when none is comparable. */
  nearestIntent: { intent: string; similarity: number } | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface ClusterResult {
  /** `semantic`: embedding cosine similarity. `lexical`: token-set (Jaccard) fallback. */
  method: ClusterMethod;
  /** Pending messages that were grouped. */
  analyzed: number;
  /** True when more pending messages exist than `maxItems`; only the most frequent were grouped. */
  truncated: boolean;
  clusters: UnmatchedCluster[];
}

export interface ClusterOptions {
  maxItems?: number;
  /** Minimum cosine similarity to the cluster leader (semantic). */
  semanticThreshold?: number;
  /** Minimum Jaccard similarity of the token sets to the cluster leader (lexical). */
  lexicalThreshold?: number;
  embedTimeoutMs?: number;
  concurrency?: number;
  topK?: number;
}

export interface ClusterDeps {
  unmatched: Pick<UnmatchedMessageRepository, 'list'>;
  intents: Pick<IntentRepository, 'findActive'>;
  /** Without an embedder and examples the use case runs in lexical mode. */
  examples?: Pick<IntentExampleRepository, 'searchSimilar'>;
  embedder?: Embedder;
  options?: ClusterOptions;
}

const DEFAULTS = {
  maxItems: 200,
  semanticThreshold: 0.75,
  lexicalThreshold: 0.5,
  embedTimeoutMs: 2000,
  concurrency: 5,
  topK: 5,
};

/**
 * Groups PENDING unmatched messages. The store keeps no vectors, so embeddings are computed at read
 * time (cached by the injected embedder); if there is no embedder, or any embedding fails, the whole
 * run falls back to a deterministic lexical grouping and says so in `method`.
 *
 * Leader clustering in list order (most frequent first): a message joins the existing cluster whose
 * leader it resembles most when that similarity reaches the threshold, otherwise it starts a new one.
 */
export class ClusterUnmatchedUseCase {
  private readonly options: Required<ClusterOptions>;

  constructor(private readonly deps: ClusterDeps) {
    this.options = { ...DEFAULTS, ...deps.options };
  }

  async execute(): Promise<ClusterResult> {
    const { items, truncated } = await loadPendingSnapshot(this.deps.unmatched, this.options.maxItems);
    const vectors = await this.tryEmbed(items);
    const method: ClusterMethod = vectors ? 'semantic' : 'lexical';

    const similarity = vectors
      ? (a: Unmatched, b: Unmatched) => cosine(vectors.get(a.maskedText) ?? [], vectors.get(b.maskedText) ?? [])
      : lexicalSimilarity();
    const threshold = vectors ? this.options.semanticThreshold : this.options.lexicalThreshold;

    const groups = leaderClusters(items, similarity, threshold);
    const nearest = vectors ? await this.nearestBySemantic(groups, vectors) : await this.nearestByKeywords(groups);

    const clusters = groups.map((group, index) => toCluster(group, nearest[index] ?? null));
    clusters.sort((a, b) => b.size - a.size || b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id));
    return { method, analyzed: items.length, truncated, clusters };
  }

  private async tryEmbed(items: Unmatched[]): Promise<Map<string, number[]> | null> {
    const { embedder } = this.deps;
    if (!embedder || items.length === 0) return null;
    try {
      return await embedTexts(
        embedder,
        items.map((item) => item.maskedText),
        { concurrency: this.options.concurrency, timeoutMs: this.options.embedTimeoutMs },
      );
    } catch (error) {
      console.error('clusters: embedding failed, using lexical grouping:', error instanceof Error ? error.message : 'unknown error');
      return null;
    }
  }

  private async nearestBySemantic(groups: Unmatched[][], vectors: Map<string, number[]>) {
    const { examples } = this.deps;
    return mapLimit(groups, this.options.concurrency, async (group) => {
      const leader = group[0] as Unmatched;
      const vector = vectors.get(leader.maskedText);
      if (!examples || !vector) return null;
      try {
        const [top] = await examples.searchSimilar(vector, this.options.topK);
        return top ? { intent: top.intent, similarity: top.similarity } : null;
      } catch (error) {
        console.error('clusters: nearest-intent lookup failed:', error instanceof Error ? error.message : 'unknown error');
        return null;
      }
    });
  }

  /** Lexical nearest intent: Jaccard between the leader's tokens and each intent's name + keyword tokens. */
  private async nearestByKeywords(groups: Unmatched[][]) {
    const catalog = (await this.deps.intents.findActive()).map((intent) => ({
      name: intent.name,
      tokens: tokenize(`${intent.name.replace(/[_-]+/g, ' ')} ${intent.keywords.join(' ')}`),
    }));
    return groups.map((group) => {
      const tokens = tokenize((group[0] as Unmatched).maskedText);
      let best: { intent: string; similarity: number } | null = null;
      for (const intent of catalog) {
        const score = jaccard(tokens, intent.tokens);
        if (score > 0 && (!best || score > best.similarity)) best = { intent: intent.name, similarity: score };
      }
      return best;
    });
  }
}

const lexicalSimilarity = (): ((a: Unmatched, b: Unmatched) => number) => {
  const cache = new Map<string, Set<string>>();
  const tokens = (item: Unmatched) => {
    let set = cache.get(item.id);
    if (!set) {
      set = tokenize(item.maskedText);
      cache.set(item.id, set);
    }
    return set;
  };
  return (a, b) => jaccard(tokens(a), tokens(b));
};

function leaderClusters(
  items: Unmatched[],
  similarity: (a: Unmatched, b: Unmatched) => number,
  threshold: number,
): Unmatched[][] {
  const groups: Unmatched[][] = [];
  for (const item of items) {
    let bestGroup: Unmatched[] | null = null;
    let bestScore = -Infinity;
    for (const group of groups) {
      const score = similarity(group[0] as Unmatched, item);
      if (score >= threshold && score > bestScore) {
        bestGroup = group;
        bestScore = score;
      }
    }
    if (bestGroup) bestGroup.push(item);
    else groups.push([item]);
  }
  return groups;
}

function toCluster(group: Unmatched[], nearestIntent: UnmatchedCluster['nearestIntent']): UnmatchedCluster {
  const leader = group[0] as Unmatched;
  const ids = group.map((item) => item.id);
  return {
    id: createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 12),
    representativeText: leader.maskedText,
    size: group.reduce((sum, item) => sum + item.occurrences, 0),
    memberIds: ids,
    members: group.map(({ id, maskedText, occurrences }) => ({ id, maskedText, occurrences })),
    nearestIntent,
    firstSeenAt: new Date(Math.min(...group.map((item) => item.firstSeenAt.getTime()))),
    lastSeenAt: new Date(Math.max(...group.map((item) => item.lastSeenAt.getTime()))),
  };
}
