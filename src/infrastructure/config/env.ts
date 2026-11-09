import dotenv from 'dotenv';

dotenv.config();

const requiredEnv = ['DATABASE_URL', 'AUTH_JWT_SECRET', 'INTERNAL_SECRET'] as const;

for (const variableName of requiredEnv) {
  if (!process.env[variableName]) {
    throw new Error(`Missing required env variable: ${variableName}`);
  }
}

const DEFAULT_CATALOG_CACHE_TTL_MS = 15000;

/** Non-negative integer ms; anything invalid falls back to the default. 0 disables the cache. */
export const parseCatalogCacheTtl = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CATALOG_CACHE_TTL_MS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CATALOG_CACHE_TTL_MS;
};

const DEFAULT_UNMATCHED_MAX_LENGTH = 500;

/** Capture stores message text, so it is opt-in: only the literal 'true' enables it. */
export const parseUnmatchedCaptureEnabled = (raw: string | undefined): boolean => raw === 'true';

/** Positive integer; invalid -> 500. Clamped to 500 (the unmatched_messages column CHECK). */
export const parseUnmatchedMaxLength = (raw: string | undefined): number => {
  if (raw === undefined || raw.trim() === '') return DEFAULT_UNMATCHED_MAX_LENGTH;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_UNMATCHED_MAX_LENGTH;
  return Math.min(value, DEFAULT_UNMATCHED_MAX_LENGTH);
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : fallback;
};

/** Days an unmatched message is kept after it was last seen; positive integer, default 30. */
export const parseUnmatchedRetentionDays = (raw: string | undefined): number => positiveInt(raw, 30);

const numberInRange = (raw: string | undefined, fallback: number, ok: (n: number) => boolean): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && ok(value) ? value : fallback;
};

const nonEmpty = (raw: string | undefined): string | undefined => {
  const value = raw?.trim();
  return value ? value : undefined;
};

/** Semantic matching sends (masked) text to AWS Bedrock, so it is opt-in: only 'true' enables it. */
export const parseSemanticEnabled = (raw: string | undefined): boolean => raw === 'true';
/** LLM disambiguation is on by default (when semantic is enabled); only 'false' disables it. */
export const parseDisambiguationEnabled = (raw: string | undefined): boolean => raw !== 'false';
/** (0, 1]; default 0.80. */
export const parseSemanticMinSimilarity = (raw: string | undefined): number =>
  numberInRange(raw, 0.8, (n) => n > 0 && n <= 1);
/** [0, 1); default 0.05. */
export const parseSemanticAmbiguityMargin = (raw: string | undefined): number =>
  numberInRange(raw, 0.05, (n) => n >= 0 && n < 1);
export const parseSemanticTopK = (raw: string | undefined): number => positiveInt(raw, 5);
export const parseSemanticBudgetMs = (raw: string | undefined): number => positiveInt(raw, 1500);
export const parseBedrockEmbedTimeoutMs = (raw: string | undefined): number => positiveInt(raw, 800);
export const parseBedrockLlmTimeoutMs = (raw: string | undefined): number => positiveInt(raw, 1000);
export const parseBreakerFailureThreshold = (raw: string | undefined): number => positiveInt(raw, 5);
export const parseBreakerCooldownMs = (raw: string | undefined): number => positiveInt(raw, 30000);
export const parseEmbedModelId = (raw: string | undefined): string => nonEmpty(raw) ?? 'amazon.titan-embed-text-v2:0';
export const parseDisambiguatorModelId = (raw: string | undefined): string =>
  nonEmpty(raw) ?? 'amazon.nova-micro-v1:0';
export const parseAwsRegion = (raw: string | undefined): string | undefined => nonEmpty(raw);

export const env = {
  semanticEnabled: parseSemanticEnabled(process.env.SEMANTIC_ENABLED),
  disambiguationEnabled: parseDisambiguationEnabled(process.env.DISAMBIGUATION_ENABLED),
  semanticMinSimilarity: parseSemanticMinSimilarity(process.env.SEMANTIC_MIN_SIMILARITY),
  semanticAmbiguityMargin: parseSemanticAmbiguityMargin(process.env.SEMANTIC_AMBIGUITY_MARGIN),
  semanticTopK: parseSemanticTopK(process.env.SEMANTIC_TOP_K),
  semanticBudgetMs: parseSemanticBudgetMs(process.env.SEMANTIC_BUDGET_MS),
  bedrockEmbedTimeoutMs: parseBedrockEmbedTimeoutMs(process.env.BEDROCK_EMBED_TIMEOUT_MS),
  bedrockLlmTimeoutMs: parseBedrockLlmTimeoutMs(process.env.BEDROCK_LLM_TIMEOUT_MS),
  breakerFailureThreshold: parseBreakerFailureThreshold(process.env.BREAKER_FAILURE_THRESHOLD),
  breakerCooldownMs: parseBreakerCooldownMs(process.env.BREAKER_COOLDOWN_MS),
  bedrockEmbedModelId: parseEmbedModelId(process.env.BEDROCK_EMBED_MODEL_ID),
  bedrockDisambiguatorModelId: parseDisambiguatorModelId(process.env.BEDROCK_DISAMBIGUATOR_MODEL_ID),
  awsRegion: parseAwsRegion(process.env.AWS_REGION),
  unmatchedCaptureEnabled: parseUnmatchedCaptureEnabled(process.env.UNMATCHED_CAPTURE_ENABLED),
  unmatchedMaxLength: parseUnmatchedMaxLength(process.env.UNMATCHED_MAX_LENGTH),
  unmatchedRetentionDays: parseUnmatchedRetentionDays(process.env.UNMATCHED_RETENTION_DAYS),
  catalogCacheTtlMs: parseCatalogCacheTtl(process.env.INTENTS_CATALOG_CACHE_TTL_MS),
  port: Number.parseInt(process.env.PORT ?? '4002', 10),
  databaseUrl: process.env.DATABASE_URL as string,
  jwtSecret: process.env.AUTH_JWT_SECRET as string,
  internalSecret: process.env.INTERNAL_SECRET as string,
  pgSsl: process.env.PG_SSL === 'true',
};
