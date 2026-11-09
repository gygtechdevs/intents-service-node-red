import { createHash } from 'node:crypto';
import type { UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { normalize } from '../../domain/services/IntentDetector';
import { DEFAULT_MAX_LENGTH, maskPii } from '../../domain/services/PiiMasker';

/** What DetectIntentUseCase needs from a capture sink. */
export interface MissRecorder {
  record(text: string): Promise<void>;
}

/** Masks (then caps) a missed message, hashes it for dedup and upserts it. Raw text never leaves here. */
export class UnmatchedRecorder implements MissRecorder {
  private readonly maxLength: number;

  constructor(
    private readonly repository: Pick<UnmatchedMessageRepository, 'upsert'>,
    options: { maxLength?: number } = {},
  ) {
    this.maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  }

  async record(text: string): Promise<void> {
    const masked = maskPii(text, this.maxLength);
    if (!masked) return;
    const hash = createHash('sha256').update(normalize(masked)).digest('hex');
    await this.repository.upsert(masked, hash);
  }
}
