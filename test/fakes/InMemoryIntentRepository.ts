import { randomUUID } from 'node:crypto';
import type { Intent } from '../../src/domain/entities/Intent';
import {
  DuplicateIntentError,
  type IntentRepository,
  type NewIntent,
} from '../../src/domain/repositories/IntentRepository';

export class InMemoryIntentRepository implements IntentRepository {
  readonly items = new Map<string, Intent>();

  async findActive(): Promise<Intent[]> {
    return [...this.items.values()]
      .filter((i) => i.active)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findByName(name: string): Promise<Intent | null> {
    return this.items.get(name) ?? null;
  }

  async create(data: NewIntent): Promise<Intent> {
    if (this.items.has(data.name)) throw new DuplicateIntentError(data.name);
    const now = new Date();
    const intent: Intent = {
      id: randomUUID(),
      name: data.name,
      keywords: data.keywords,
      tags: data.tags,
      initialStep: typeof data.steps.initialStep === 'string' ? data.steps.initialStep : '',
      ...(typeof data.steps.description === 'string' ? { description: data.steps.description } : {}),
      steps: data.steps,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(intent.name, intent);
    return intent;
  }

  async save(intent: Intent): Promise<Intent> {
    const saved: Intent = { ...intent, updatedAt: new Date() };
    this.items.set(saved.name, saved);
    return saved;
  }
}
