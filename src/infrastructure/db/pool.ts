import { Pool } from 'pg';

const OWNED_TABLES = ['intents', 'message_events', 'unmatched_messages'];
/** Only required (and only checked) when semantic detection is enabled. */
const SEMANTIC_TABLES = ['intent_examples'];

export const createPool = (databaseUrl: string, ssl: boolean): Pool =>
  new Pool({ connectionString: databaseUrl, ssl: ssl ? { rejectUnauthorized: false } : undefined });

/** The schema is owned by migrations: fail fast if it has not been applied. */
export const assertSchema = async (pool: Pool, options: { semanticEnabled?: boolean } = {}): Promise<void> => {
  const tables = options.semanticEnabled ? [...OWNED_TABLES, ...SEMANTIC_TABLES] : OWNED_TABLES;
  const result = await pool.query<{ t: string; present: boolean }>(
    `SELECT t, (to_regclass('public.' || t) IS NOT NULL) AS present
       FROM unnest($1::text[]) AS t`,
    [tables],
  );
  const missing = result.rows.filter((row) => !row.present).map((row) => row.t);
  if (missing.length > 0) {
    throw new Error(
      `Missing intents tables in the database: ${missing.join(', ')}. ` +
        'The schema is owned by migrations - run `npm run migrate:up` before starting the service.',
    );
  }
};
