import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, type DbClient, type DbPool } from './pool.js';
import { createLogger, type Logger } from '../logging/logger.js';

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Arbitrary constant identifying the migration lock. Any session that wants to
 * migrate takes this same advisory lock, so the number only has to be stable.
 */
const MIGRATION_LOCK_KEY = 4_872_301;

async function ensureMigrationsTable(client: DbClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Applies every unapplied .sql file in migrations/ in filename order. Each file
 * runs in its own transaction so a failure leaves the schema consistent.
 *
 * The whole pass is wrapped in a Postgres advisory lock because the worker, the
 * API and a manual `db:migrate` all migrate on startup and can easily overlap.
 * Without the lock two runners both read the same "unapplied" set, both execute
 * the DDL, and the loser dies on the `schema_migrations` primary key — which
 * took down the worker on a deploy that raced a manual migration. Holding the
 * lock while reading that set means the second runner simply finds nothing to do.
 */
export async function runMigrations(pool: DbPool = getPool(), logger: Logger = createLogger()): Promise<string[]> {
  const client = await pool.connect();
  const newlyApplied: string[] = [];
  let unlocked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureMigrationsTable(client);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        newlyApplied.push(file);
        logger.info('migration applied', { file });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      unlocked = true;
    } catch {
      // Fall through: the connection is discarded below, which drops the lock
      // with the session. Returning it to the pool still holding the lock would
      // block every later migration forever.
    }
    client.release(unlocked ? undefined : true);
  }

  if (newlyApplied.length === 0) logger.info('schema already up to date');
  return newlyApplied;
}
