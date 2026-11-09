import type { Pool } from 'pg';
import { readSteps, type Intent, type IntentSteps } from '../../domain/entities/Intent';
import {
  DuplicateIntentError,
  type IntentRepository,
  type NewIntent,
} from '../../domain/repositories/IntentRepository';

interface IntentRow {
  id: string;
  key: string;
  keywords: string[];
  tags: string[];
  steps: IntentSteps;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, key, keywords, tags, steps, active, created_at, updated_at';
const UNIQUE_VIOLATION = '23505';

const toIntent = (row: IntentRow): Intent => ({
  id: row.id,
  name: row.key,
  keywords: row.keywords,
  tags: row.tags ?? [],
  ...readSteps(row.steps),
  steps: row.steps,
  active: row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class PgIntentRepository implements IntentRepository {
  constructor(private readonly pool: Pool) {}

  async findActive(): Promise<Intent[]> {
    const result = await this.pool.query<IntentRow>(
      `SELECT ${COLUMNS} FROM intents WHERE active = true ORDER BY key ASC`,
    );
    return result.rows.map(toIntent);
  }

  async findByName(name: string): Promise<Intent | null> {
    const result = await this.pool.query<IntentRow>(`SELECT ${COLUMNS} FROM intents WHERE key = $1`, [name]);
    const row = result.rows[0];
    return row ? toIntent(row) : null;
  }

  async create(data: NewIntent): Promise<Intent> {
    try {
      const result = await this.pool.query<IntentRow>(
        `INSERT INTO intents (key, keywords, tags, steps) VALUES ($1, $2, $3, $4::jsonb) RETURNING ${COLUMNS}`,
        [data.name, data.keywords, data.tags, JSON.stringify(data.steps)],
      );
      return toIntent(result.rows[0] as IntentRow);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateIntentError(data.name);
      }
      throw error;
    }
  }

  async save(intent: Intent): Promise<Intent> {
    const result = await this.pool.query<IntentRow>(
      `UPDATE intents
          SET keywords = $2, tags = $3, steps = $4::jsonb, active = $5, updated_at = now()
        WHERE id = $1
    RETURNING ${COLUMNS}`,
      [intent.id, intent.keywords, intent.tags, JSON.stringify(intent.steps), intent.active],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Intent ${intent.id} not found`);
    }
    return toIntent(row);
  }
}
