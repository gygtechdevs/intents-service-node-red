/** Placeholders written by the PII masker, e.g. [EMAIL]; they carry no meaning for similarity. */
const PLACEHOLDER = /\[[A-Z_]+\]/g;

/** Lowercased, accent-free word set; 1-character tokens and PII placeholders are dropped. */
export const tokenize = (text: string): Set<string> => {
  const normalized = text
    .replace(PLACEHOLDER, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const tokens = normalized.match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter((token) => token.length >= 2));
};

/** |a ∩ b| / |a ∪ b|; 0 when both sets are empty. */
export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
};

export const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};
