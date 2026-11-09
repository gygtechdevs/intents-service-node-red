import { describe, it, expect } from 'vitest';
import { detectIntent } from '../../src/domain/services/IntentDetector';

const catalog = [
  { name: 'plazo_fijo', initialStep: '/stepin/pf', keywords: ['plazo fijo', 'inversion', 'tasa'] },
  { name: 'tarjeta', initialStep: '/stepin/tc', keywords: ['tarjeta', 'credito'] },
];

describe('detectIntent', () => {
  it('returns null for empty or whitespace-only text', () => {
    expect(detectIntent('', catalog)).toBeNull();
    expect(detectIntent('   ', catalog)).toBeNull();
    expect(detectIntent(undefined as unknown as string, catalog)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(detectIntent('hola buen dia', catalog)).toBeNull();
  });

  it('returns null for an empty catalog', () => {
    expect(detectIntent('plazo fijo', [])).toBeNull();
  });

  it('matches case-insensitively and ignoring diacritics on both sides', () => {
    expect(detectIntent('Quiero una INVERSIÓN', catalog)?.intent).toBe('plazo_fijo');
    const accented = detectIntent('tarjeta de crédito', [
      { name: 'tc', initialStep: '/s', keywords: ['Crédito'] },
    ]);
    expect(accented?.matchedKeywords).toEqual(['credito']);
  });

  it('collapses repeated whitespace before matching', () => {
    expect(detectIntent('quiero   un   plazo \n fijo', catalog)?.intent).toBe('plazo_fijo');
  });

  it('picks the intent with the most matched keywords', () => {
    const result = detectIntent('tarjeta de credito y plazo fijo', catalog);
    expect(result?.intent).toBe('tarjeta');
    expect(result?.matchedKeywords).toEqual(['tarjeta', 'credito']);
    expect(result?.initialStep).toBe('/stepin/tc');
  });

  it('keeps catalog order on ties (stable sort)', () => {
    expect(detectIntent('plazo fijo tarjeta', catalog)?.intent).toBe('plazo_fijo');
  });

  it('computes confidence as min(1, score / 3)', () => {
    expect(detectIntent('tarjeta', catalog)?.confidence).toBeCloseTo(1 / 3);
    expect(detectIntent('tarjeta credito', catalog)?.confidence).toBeCloseTo(2 / 3);
    expect(detectIntent('plazo fijo inversion tasa', catalog)?.confidence).toBe(1);
    const many = [{ name: 'x', initialStep: '/s', keywords: ['a', 'b', 'c', 'd'] }];
    expect(detectIntent('a b c d', many)?.confidence).toBe(1);
  });

  it('ignores blank keywords and tolerates a non-array keywords field', () => {
    const odd = [
      { name: 'blank', initialStep: '/s', keywords: ['', '  '] },
      { name: 'broken', initialStep: '/s', keywords: undefined as unknown as string[] },
    ];
    expect(detectIntent('anything', odd)).toBeNull();
  });
});
