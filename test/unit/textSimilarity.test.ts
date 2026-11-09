import { describe, expect, it } from 'vitest';
import { cosine, jaccard, tokenize } from '../../src/application/services/textSimilarity';
import { decide } from '../../src/application/services/semanticDecision';

describe('tokenize', () => {
  it('lowercases, strips diacritics and punctuation, drops 1-char tokens and PII placeholders', () => {
    expect([...tokenize('Reset MY password, please! [EMAIL] a')]).toEqual(['reset', 'my', 'password', 'please']);
    expect([...tokenize('Cambiar contraseña')]).toEqual(['cambiar', 'contrasena']);
  });

  it('returns a set (no duplicates)', () => {
    expect(tokenize('pay pay pay').size).toBe(1);
  });
});

describe('jaccard', () => {
  it('is |intersection| / |union|, 1 for equal sets and 0 for disjoint or empty ones', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(['a']), new Set(['a']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('cosine', () => {
  it('computes cosine similarity and returns 0 for zero vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('decide (mirrors the hybrid classifier decision rule)', () => {
  const options = { minSimilarity: 0.8, ambiguityMargin: 0.05 };

  it('none when the best similarity is below the minimum or there are no candidates', () => {
    expect(decide(new Map([['a', 0.79]]), options)).toEqual({ kind: 'none' });
    expect(decide(new Map(), options)).toEqual({ kind: 'none' });
  });

  it('match when alone or clear of the runner-up by the margin', () => {
    expect(decide(new Map([['a', 0.9]]), options)).toEqual({ kind: 'match', intent: 'a', similarity: 0.9 });
    expect(
      decide(
        new Map([
          ['a', 0.95],
          ['b', 0.85],
        ]),
        options,
      ),
    ).toMatchObject({ kind: 'match', intent: 'a' });
  });

  it('ambiguous (left to the LLM at runtime) when the runner-up is within the margin', () => {
    expect(
      decide(
        new Map([
          ['a', 0.9],
          ['b', 0.88],
        ]),
        options,
      ),
    ).toEqual({ kind: 'ambiguous', intents: ['a', 'b'] });
  });
});
