import type { UnmatchedMessageRepository } from '../../domain/repositories/UnmatchedMessageRepository';
import { ALREADY_RESOLVED, loadPending } from './unmatchedReview';

export class RejectUnmatchedUseCase {
  constructor(private readonly repository: Pick<UnmatchedMessageRepository, 'findById' | 'claim'>) {}

  async execute(id: string, by: string): Promise<void> {
    await loadPending(this.repository, id);
    const claimed = await this.repository.claim(id, 'rejected', by);
    if (!claimed) throw ALREADY_RESOLVED(); // lost a race with another reviewer
  }
}
