import { describe, it, expect, vi } from 'vitest';
import type { DetectedIntent, Intent } from '../../src/domain/entities/Intent';
import type { IntentRepository } from '../../src/domain/repositories/IntentRepository';
import { detectIntent } from '../../src/domain/services/IntentDetector';
import { KeywordIntentClassifier } from '../../src/application/services/KeywordIntentClassifier';
import { DetectIntentUseCase } from '../../src/application/use-cases/DetectIntentUseCase';
import { FakeIntentClassifier } from '../fakes/FakeIntentClassifier';

const intent = (name: string, keywords: string[], tags: string[] = []): Intent => ({
  id: name,
  name,
  keywords,
  tags,
  initialStep: `/${name}`,
  steps: {},
  active: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const catalog: Intent[] = [
  intent('plazo_fijo', ['Plazo  Fijo', 'inversión', 'tasa'], ['ahorro']),
  intent('tarjeta', ['tarjeta', 'CRÉDITO', 'tarjeta']),
  intent('empate_a', ['tasa', 'cuota']),
  intent('empate_b', ['cuota', 'tasa']),
  intent('vacio', ['', '   ']),
];

const messages = [
  'Quiero un PLAZO fijo con buena tasa',
  'mi tarjeta de crédito',
  'tasa y cuota',
  'cuota',
  'hola mundo',
  '',
  '   ',
  undefined as unknown as string,
];

describe('KeywordIntentClassifier', () => {
  it.each(messages.map((m) => [String(m)] as const))('is identical to detectIntent for %j', async (label) => {
    const message = messages.find((m) => String(m) === label)!;
    const classifier = new KeywordIntentClassifier();
    expect(await classifier.classify(message, catalog)).toEqual(detectIntent(message, catalog));
  });

  it('does not tag results with a source (response body unchanged)', async () => {
    const result = await new KeywordIntentClassifier().classify('tarjeta', catalog);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('source');
  });

  it('compiles once per catalog snapshot', async () => {
    const classifier = new KeywordIntentClassifier();
    const spy = vi.spyOn(String.prototype, 'normalize');
    await classifier.classify('tarjeta', catalog);
    const afterFirst = spy.mock.calls.length;
    await classifier.classify('tarjeta', catalog);
    expect(spy.mock.calls.length - afterFirst).toBe(1); // message only
    spy.mockRestore();
  });
});

describe('DetectIntentUseCase with an injected IntentClassifier', () => {
  const repo = { findActive: async () => catalog } as unknown as IntentRepository;

  it('returns the classifier result and passes the active catalog', async () => {
    const canned: DetectedIntent = {
      intent: 'fake',
      initialStep: '/fake',
      confidence: 0.9,
      matchedKeywords: [],
      tags: [],
      source: 'semantic',
    };
    const fake = new FakeIntentClassifier(canned);
    const result = await new DetectIntentUseCase(repo, fake).execute('anything');
    expect(result).toEqual(canned);
    expect(fake.calls).toEqual([{ text: 'anything', catalog }]);
  });

  it('returns null when the classifier returns null', async () => {
    const result = await new DetectIntentUseCase(repo, new FakeIntentClassifier(null)).execute('x');
    expect(result).toBeNull();
  });

  it('defaults to keyword classification', async () => {
    const result = await new DetectIntentUseCase(repo).execute('mi tarjeta');
    expect(result?.intent).toBe('tarjeta');
  });
});
