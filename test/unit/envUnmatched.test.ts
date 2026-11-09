import { beforeAll, describe, expect, it, vi } from 'vitest';

let parseUnmatchedCaptureEnabled: (raw: string | undefined) => boolean;
let parseUnmatchedMaxLength: (raw: string | undefined) => number;

beforeAll(async () => {
  vi.stubEnv('DATABASE_URL', 'postgres://x');
  vi.stubEnv('AUTH_JWT_SECRET', 's');
  vi.stubEnv('INTERNAL_SECRET', 'i');
  ({ parseUnmatchedCaptureEnabled, parseUnmatchedMaxLength } = await import('../../src/infrastructure/config/env'));
});

describe('parseUnmatchedCaptureEnabled', () => {
  it('defaults to false and is true only for the literal "true"', () => {
    expect(parseUnmatchedCaptureEnabled(undefined)).toBe(false);
    expect(parseUnmatchedCaptureEnabled('')).toBe(false);
    expect(parseUnmatchedCaptureEnabled('1')).toBe(false);
    expect(parseUnmatchedCaptureEnabled('yes')).toBe(false);
    expect(parseUnmatchedCaptureEnabled('true')).toBe(true);
  });
});

describe('parseUnmatchedMaxLength', () => {
  it('defaults to 500 and falls back on invalid values', () => {
    for (const raw of [undefined, '', 'abc', '-5', '0', '1.5']) expect(parseUnmatchedMaxLength(raw)).toBe(500);
  });
  it('accepts positive integers and clamps to the column limit of 500', () => {
    expect(parseUnmatchedMaxLength('200')).toBe(200);
    expect(parseUnmatchedMaxLength('9000')).toBe(500);
  });
});
