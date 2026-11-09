import { describe, it, expect, vi } from 'vitest';
import type { DetectableIntent, DetectedIntent, Intent } from '../../src/domain/entities/Intent';
import { compileCatalog, detectCompiled, detectIntent } from '../../src/domain/services/IntentDetector';
import { DetectIntentUseCase } from '../../src/application/use-cases/DetectIntentUseCase';
import type { IntentRepository } from '../../src/domain/repositories/IntentRepository';

/** Verbatim copy of the pre-optimization algorithm, used as the oracle. */
function normalize(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function legacyDetect(messageText: string, catalog: DetectableIntent[]): DetectedIntent | null {
  const message = normalize(messageText);
  if (!message) return null;
  const scored = catalog
    .map((item) => {
      const keywords = Array.isArray(item.keywords) ? item.keywords : [];
      const normalizedKeywords = keywords.map((k) => normalize(k)).filter(Boolean);
      const matchedKeywords = normalizedKeywords.filter((k) => message.includes(k));
      return {
        intent: item.name,
        initialStep: item.initialStep,
        tags: Array.isArray(item.tags) ? item.tags : [],
        matchedKeywords,
        score: matchedKeywords.length,
      };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score);
  const w = scored[0];
  if (!w) return null;
  return {
    intent: w.intent,
    initialStep: w.initialStep,
    confidence: Math.min(1, w.score / 3),
    matchedKeywords: w.matchedKeywords,
    tags: w.tags,
  };
}

const catalog: DetectableIntent[] = [
  { name: 'plazo_fijo', initialStep: '/pf', keywords: ['Plazo  Fijo', 'inversión', 'tasa'], tags: ['ahorro'] },
  { name: 'tarjeta', initialStep: '/tc', keywords: ['tarjeta', 'CRÉDITO', 'tarjeta'], tags: ['cards', 'x'] },
  { name: 'empate_a', initialStep: '/a', keywords: ['tasa', 'cuota'] },
  { name: 'empate_b', initialStep: '/b', keywords: ['cuota', 'tasa'], tags: [] },
  { name: 'vacio', initialStep: '/v', keywords: ['', '   ', '\n'] },
  { name: 'sin_keywords', initialStep: '/n', keywords: undefined as unknown as string[] },
  { name: 'cafe', initialStep: '/c', keywords: ['café', 'cafe'] },
];

const messages = [
  'Quiero un PLAZO fijo con buena tasa',
  'mi tarjeta de crédito',
  'tasa y cuota',
  'cuota',
  'un cafe o un CAFÉ',
  'inversion',
  'hola mundo',
  '',
  '   ',
  'tasa   \n cuota\ttarjeta credito inversión plazo fijo',
  undefined as unknown as string,
];

describe('compiled detection equivalence', () => {
  const compiled = compileCatalog(catalog);

  it.each(messages.map((m) => [String(m)] as const))('matches the legacy algorithm for %j', (_label) => {
    const message = messages.find((m) => String(m) === _label)!;
    const expected = legacyDetect(message, catalog);
    expect(detectIntent(message, catalog)).toEqual(expected);
    expect(detectCompiled(message, compiled)).toEqual(expected);
    // Compiled form is reusable: a second call gives the same answer.
    expect(detectCompiled(message, compiled)).toEqual(expected);
  });

  it('keeps the first intent on score ties (stable sort)', () => {
    expect(detectCompiled('tasa cuota', compiled)?.intent).toBe('empate_a');
  });

  it('does not re-normalize keywords per message', () => {
    const spy = vi.spyOn(String.prototype, 'normalize');
    detectCompiled('plazo fijo', compiled);
    // Only the message itself is normalized.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('DetectIntentUseCase compiled-catalog cache', () => {
  const intent = (name: string, keywords: string[]): Intent => ({
    id: name,
    name,
    keywords,
    tags: [],
    initialStep: '/s',
    steps: {},
    active: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it('compiles once per snapshot and recompiles when the snapshot changes', async () => {
    let snapshot: Intent[] = [intent('a', ['hola'])];
    const repo = { findActive: async () => snapshot } as unknown as IntentRepository;
    const useCase = new DetectIntentUseCase(repo);
    const spy = vi.spyOn(String.prototype, 'normalize');

    await useCase.execute('hola');
    const afterFirst = spy.mock.calls.length; // message + 1 keyword
    await useCase.execute('hola');
    expect(spy.mock.calls.length - afterFirst).toBe(1); // message only

    snapshot = [intent('b', ['adios'])];
    expect((await useCase.execute('adios'))?.intent).toBe('b');
    spy.mockRestore();
  });
});
