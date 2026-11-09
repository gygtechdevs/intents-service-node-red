import { ApplicationError } from '../errors/ApplicationError';

export const MAX_NAME_LENGTH = 120;
const NAME_PATTERN = /^[a-zA-Z0-9 _-]+$/;

export function validateName(raw: string): string {
  const name = raw.trim();
  if (!name || name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
    throw new ApplicationError(
      `name must be 1-${MAX_NAME_LENGTH} characters: letters, numbers, spaces, "_" and "-"`,
      400,
    );
  }
  return name;
}

export function cleanKeywords(raw: string[]): string[] {
  const keywords = raw.map((keyword) => keyword.trim()).filter((keyword) => keyword.length > 0);
  if (keywords.length === 0) {
    throw new ApplicationError('keywords must contain at least one non-empty keyword', 400);
  }
  return keywords;
}

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS = 10;
const TAG_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u;

/**
 * Trims each tag, rejects blank/overlong/odd-charset ones and drops
 * case-insensitive duplicates (the first casing wins). Empty input is valid.
 */
export function cleanTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of raw) {
    const tag = item.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) {
      throw new ApplicationError(
        `each tag must be 1-${MAX_TAG_LENGTH} characters: letters, numbers, spaces, "_" and "-"`,
        400,
      );
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new ApplicationError(`at most ${MAX_TAGS} tags are allowed`, 400);
  }
  return tags;
}

export function validateInitialStep(raw: string): string {
  const initialStep = raw.trim();
  if (!initialStep) {
    throw new ApplicationError('initialStep is required', 400);
  }
  return initialStep;
}
