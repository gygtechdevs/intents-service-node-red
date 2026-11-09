import type { DisambiguationCandidate, IntentDisambiguator } from '../../src/domain/ports/IntentDisambiguator';

export class FakeDisambiguator implements IntentDisambiguator {
  readonly calls: Array<{ text: string; candidates: DisambiguationCandidate[] }> = [];
  failWith: Error | null = null;

  constructor(public answer: string | null = null) {}

  async choose(text: string, candidates: DisambiguationCandidate[]): Promise<string | null> {
    this.calls.push({ text, candidates });
    if (this.failWith) throw this.failWith;
    return this.answer;
  }
}
