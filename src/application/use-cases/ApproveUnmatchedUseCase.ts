import type { Embedder } from '../../domain/ports/Embedder';
import type { IntentExampleRepository } from '../../domain/repositories/IntentExampleRepository';
import type { IntentRepository } from '../../domain/repositories/IntentRepository';
import type { Unmatched, UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { runWithTimeout } from '../../infrastructure/resilience/deadline';
import { ApplicationError } from '../errors/ApplicationError';
import { hashText } from '../services/IntentExamplesSync';
import type { CreateIntentInput, CreateIntentUseCase } from './CreateIntentUseCase';
import { ALREADY_RESOLVED, loadPending } from './unmatchedReview';

const DEFAULT_EMBED_TIMEOUT_MS = 2000;

export interface ApproveResult {
  id: string;
  intent: string;
  /** false = the example was saved without an embedding; the re-embed sweep will pick it up. */
  embedded: boolean;
}

export interface ApproveDeps {
  unmatched: Pick<UnmatchedMessageRepository, 'findById' | 'claim' | 'release'>;
  intents: Pick<IntentRepository, 'findByName'>;
  createIntent: Pick<CreateIntentUseCase, 'execute'>;
  examples: Pick<IntentExampleRepository, 'upsertMany'>;
  embedder: Embedder;
  embedModelId: string;
  embedTimeoutMs?: number;
}

/**
 * Human-in-the-loop approval of a missed message as a training example.
 *
 * Order matters: (1) claim the item with a conditional update so only one reviewer wins (a loser
 * gets 409), (2) save the example, embedding it first when possible, (3) if the save fails, release
 * the claim so the item can be reviewed again. An embedding failure is NOT an error: the example is
 * stored with a NULL embedding and reported as `embedded: false`.
 */
export class ApproveUnmatchedUseCase {
  constructor(private readonly deps: ApproveDeps) {}

  /** Approves the message as an example of an existing, active intent. */
  async approveExisting(id: string, intentName: string, by: string): Promise<ApproveResult> {
    const item = await loadPending(this.deps.unmatched, id);
    const intent = await this.deps.intents.findByName(intentName);
    if (!intent?.active) throw new ApplicationError(`Intent "${intentName}" not found`, 404);

    await this.claim(id, by, intent.name);
    return this.saveExample(item, intent.name);
  }

  /** Creates a new intent (same validation as POST /intents) and approves the message into it. */
  async approveNew(id: string, definition: CreateIntentInput, by: string): Promise<ApproveResult> {
    const item = await loadPending(this.deps.unmatched, id);
    await this.claim(id, by, definition.name.trim());

    let name: string;
    try {
      name = (await this.deps.createIntent.execute(definition)).name;
    } catch (error) {
      await this.releaseQuietly(id);
      throw error;
    }
    return this.saveExample(item, name);
  }

  private async claim(id: string, by: string, intent: string): Promise<void> {
    const claimed = await this.deps.unmatched.claim(id, 'approved', by, intent);
    if (!claimed) throw ALREADY_RESOLVED();
  }

  private async saveExample(item: Unmatched, intent: string): Promise<ApproveResult> {
    const { examples, embedder, embedModelId } = this.deps;
    let embedding: number[] | null = null;
    try {
      embedding = await runWithTimeout(this.deps.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS, (signal) =>
        embedder.embed(item.maskedText, signal),
      );
    } catch (error) {
      console.error('approve: embedding failed, saving example without embedding:', messageOf(error));
    }

    try {
      await examples.upsertMany([
        {
          intent,
          text: item.maskedText,
          textHash: hashText(item.maskedText),
          source: 'approved',
          embedding,
          embeddingModel: embedding ? embedModelId : null,
        },
      ]);
    } catch (error) {
      await this.releaseQuietly(item.id);
      throw error;
    }
    return { id: item.id, intent, embedded: embedding !== null };
  }

  private async releaseQuietly(id: string): Promise<void> {
    try {
      await this.deps.unmatched.release(id);
    } catch (error) {
      console.error('approve: failed to release the claim:', messageOf(error));
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');
