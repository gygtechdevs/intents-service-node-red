/**
 * Migration runner CLI for the intents-service.
 *
 *     npm run migrate:up
 *     npm run migrate:down [-- 2]      reverts the last N applied migrations
 *     npm run migrate:status
 *
 * Connection: `DATABASE_URL` (required). Runs with the schema OWNER credentials.
 * Own control table: `schema_migrations_intents` (auth-service uses
 * `schema_migrations_auth` and platform `schema_migrations_platform` on the same
 * instance, see D1).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';

const MIGRATIONS_TABLE = 'schema_migrations_intents';
const UP_MARKER = '-- migrate:up';
const DOWN_MARKER = '-- migrate:down';
const FILE_NAME_PATTERN = /^(\d{3,})_([A-Za-z0-9][A-Za-z0-9._-]*)\.sql$/;

interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  up: string[];
  down: string[];
  checksum: string;
}

interface ControlRow {
  name: string;
  checksum: string;
  applied_at: Date;
  status: 'applied';
}

function die(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (dollarTag !== null) {
      if (ch === '$' && sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }

    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      current += ' ';
      i = j;
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j += 1;
      }
      current += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }

    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') break;
        j += 1;
      }
      current += sql.slice(i, Math.min(j + 1, sql.length));
      i = j + 1;
      continue;
    }

    if (ch === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        dollarTag = tag[0];
        current += tag[0];
        i += tag[0].length;
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function parseMigration(filename: string, contents: string): MigrationFile {
  const match = FILE_NAME_PATTERN.exec(filename);
  if (!match) {
    throw new Error(`${filename}: file name must be <version>_<name>.sql with a numeric version`);
  }

  const upIdx = contents.indexOf(UP_MARKER);
  const downIdx = contents.indexOf(DOWN_MARKER, upIdx + UP_MARKER.length);
  if (upIdx === -1) throw new Error(`${filename}: missing section "${UP_MARKER}"`);
  if (downIdx === -1) throw new Error(`${filename}: missing section "${DOWN_MARKER}"`);


  return {
    version: match[1] as string,
    name: filename.replace(/\.sql$/, ''),
    filename,
    up: splitStatements(contents.slice(upIdx + UP_MARKER.length, downIdx)),
    down: splitStatements(contents.slice(downIdx + DOWN_MARKER.length)),
    checksum: checksumOf(contents),
  };
}

function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR
    ? resolve(process.env.MIGRATIONS_DIR)
    : resolve(__dirname, '../sql/migrations');
}

function loadMigrations(dir: string): MigrationFile[] {
  const filenames = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));

  return filenames
    .map((filename) => parseMigration(filename, readFileSync(join(dir, filename), 'utf8')))
    .sort((a, b) => a.version.localeCompare(b.version, 'en'));
}

function assertNoDrift(rows: ControlRow[], files: MigrationFile[]): void {
  const byName = new Map(files.map((f) => [f.name, f]));
  const drifted: string[] = [];
  for (const row of rows) {
    const file = byName.get(row.name);
    if (file && file.checksum !== row.checksum) {
      drifted.push(
        `  ${row.name}\n    applied: ${row.checksum}\n    on disk: ${file.checksum}`,
      );
    }
  }
  if (drifted.length > 0) {
    die(
      `${drifted.length} applied migration(s) changed on disk:\n${drifted.join('\n')}\n` +
        'An applied migration is immutable. Create a new one, or revert with npm run migrate:down.',
    );
  }
}

async function ensureControlTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      name       varchar(255) PRIMARY KEY,
      checksum   char(64)     NOT NULL,
      applied_at timestamptz  NOT NULL DEFAULT now(),
      status     varchar(16)  NOT NULL DEFAULT 'applied'
                 CHECK (status IN ('applied'))
    )`);
}

async function loadControlRows(client: Client): Promise<ControlRow[]> {
  const result = await client.query<ControlRow>(
    `SELECT name, checksum, applied_at, status FROM ${MIGRATIONS_TABLE} ORDER BY name`,
  );
  return result.rows;
}

async function record(
  client: Client,
  file: MigrationFile,
  status: 'applied',
): Promise<void> {
  await client.query(
    `INSERT INTO ${MIGRATIONS_TABLE} (name, checksum, applied_at, status)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (name) DO UPDATE
       SET checksum = EXCLUDED.checksum,
           applied_at = now(),
           status = EXCLUDED.status`,
    [file.name, file.checksum, status],
  );
}

async function runUp(client: Client, files: MigrationFile[]): Promise<number> {
  await ensureControlTable(client);
  const rows = await loadControlRows(client);
  assertNoDrift(rows, files);

  const done = new Set(rows.filter((r) => r.status === 'applied').map((r) => r.name));
  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file.name)) continue;

    await client.query('BEGIN');
    try {
      for (const statement of file.up) {
        await client.query(statement);
      }
      await record(client, file, 'applied');
      await client.query('COMMIT');
      applied.push(file.filename);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      die(`Migration failed: ${file.filename}: ${(err as Error).message}`);
    }
  }

  if (applied.length === 0) {
    console.log('✓ Schema up to date. Nothing to apply.');
  } else {
    console.log(`\n✓ ${applied.length} migration(s) applied:`);
    for (const name of applied) console.log(`  ${name}`);
  }
  return 0;
}

async function runDown(client: Client, files: MigrationFile[], count: number): Promise<number> {
  await ensureControlTable(client);
  const rows = await loadControlRows(client);
  assertNoDrift(rows, files);

  const byName = new Map(files.map((f) => [f.name, f]));
  const rollbackable = rows
    .filter((row) => row.status === 'applied' && byName.has(row.name))
    .sort((a, b) => b.name.localeCompare(a.name, 'en'))
    .slice(0, count);

  if (rollbackable.length === 0) {
    console.log('\n✓ No applied migrations to revert.\n');
    return 0;
  }

  const reverted: string[] = [];
  for (const row of rollbackable) {
    const file = byName.get(row.name)!;
    await client.query('BEGIN');
    try {
      for (const statement of file.down) {
        await client.query(statement);
      }
      await client.query(`DELETE FROM ${MIGRATIONS_TABLE} WHERE name = $1`, [file.name]);
      await client.query('COMMIT');
      reverted.push(file.filename);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      die(`Rollback failed for ${file.filename}: ${(err as Error).message}`);
    }
  }

  console.log(`\n✓ ${reverted.length} migration(s) reverted:`);
  for (const name of reverted) console.log(`  ${name}`);
  return 0;
}

async function runStatus(client: Client, files: MigrationFile[]): Promise<number> {
  await ensureControlTable(client);
  const rows = await loadControlRows(client);
  assertNoDrift(rows, files);

  const byName = new Map(rows.map((r) => [r.name, r]));
  const nameWidth = Math.max('NAME'.length, ...files.map((f) => f.name.length));
  const statusWidth = 'STATUS'.length;

  console.log(`\n${'NAME'.padEnd(nameWidth)}  ${'STATUS'.padEnd(statusWidth)}  APPLIED_AT`);
  console.log('-'.repeat(nameWidth + statusWidth + 30));
  for (const file of files) {
    const row = byName.get(file.name);
    const status = row ? row.status : 'pending';
    const appliedAt = row ? new Date(row.applied_at).toISOString() : '-';
    console.log(
      `${file.name.padEnd(nameWidth)}  ${status.padEnd(statusWidth)}  ${appliedAt}`,
    );
  }
  console.log('');
  return 0;
}

async function main(): Promise<number> {
  dotenv.config();

  const command = process.argv[2] ?? 'up';
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    die('DATABASE_URL is missing. Migrations run as the schema owner.');
  }

  const dir = defaultMigrationsDir();
  let files: MigrationFile[];
  try {
    files = loadMigrations(dir);
  } catch (err) {
    die(`Could not read the migrations directory (${dir}): ${(err as Error).message}`);
  }
  if (files.length === 0) {
    die(`No migrations found in ${dir}`);
  }

  const client = new Client({
    connectionString,
    ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    await client.connect();
  } catch (err) {
    const aggregate = err as { errors?: { message?: string; code?: string }[] };
    const detail =
      (err as Error).message ||
      aggregate.errors?.[0]?.message ||
      aggregate.errors?.[0]?.code ||
      (err as Error).name ||
      'unknown error';
    let host = '';
    try {
      host = new URL(connectionString).host;
    } catch {
      host = 'invalid URL';
    }
    die(
      `Could not connect to the database (${host}): ${detail}. ` +
        'Check that Postgres is running and DATABASE_URL is correct.',
    );
  }

  try {
    switch (command) {
      case 'up':
        return await runUp(client, files);
      case 'down': {
        const count = Number.parseInt(process.argv[3] ?? '1', 10);
        if (!Number.isInteger(count) || count < 1) {
          die(`Invalid rollback count: "${process.argv[3] ?? ''}". Expected an integer >= 1.`);
        }
        return await runDown(client, files, count);
      }
      case 'status':
        return await runStatus(client, files);
      default:
        die(`Unknown command: "${command}". Use up | down | status.`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`\n✗ ${(err as Error).message ?? String(err)}\n`);
    process.exit(1);
  },
);
