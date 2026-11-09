/**
 * Pure PII masker for free-text user messages (Argentine formats). Masking is deterministic and
 * idempotent (placeholders contain no digits). Names are NOT masked: residual risk is documented
 * in the README.
 *
 * Order matters: more specific patterns run before generic digit runs. `+54` phones run before
 * cards (they have 13 digits), local phones after cards (a card may start with `0`/`15`).
 * The text is masked FIRST and capped LAST, so a cut can never leave a partial PII token.
 */
export const DEFAULT_MAX_LENGTH = 500;

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, '[EMAIL]'],
  [/\b(?:https?:\/\/|www\.)\S+/gi, '[URL]'],
  [/(?<![\d-])\d{22}(?![\d-])/g, '[CBU]'],
  [/(?<![\d-])\d{2}-?\d{8}-?\d(?![\d-])/g, '[CUIT]'],
  [/\+54(?:[\s-]?\d){9,11}(?!\d)/g, '[PHONE]'],
  [/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, '[CARD]'],
  [/(?<!\d)0\d{2,4}[\s-]\d{4}[\s-]?\d{4}(?!\d)/g, '[PHONE]'],
  [/(?<!\d)15[\s-]\d{4}[\s-]?\d{4}(?!\d)/g, '[PHONE]'],
  [/(?<![\d.])(?:dni[\s:.]*)?\d{1,2}\.?\d{3}\.?\d{3}(?![\d.]?\d)/gi, '[DNI]'],
  [/\d{6,}/g, '[NUM]'],
];

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function maskPii(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  let out = collapse(String(text ?? ''));
  for (const [pattern, placeholder] of RULES) {
    out = out.replace(pattern, placeholder);
  }
  return collapse(collapse(out).slice(0, Math.max(0, maxLength)));
}
