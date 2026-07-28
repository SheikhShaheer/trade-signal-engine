import pg from 'pg';
import { getEnv } from '../config/env.js';

const { Pool, types } = pg;

// pg returns BIGINT and NUMERIC as strings to avoid precision loss. Every
// numeric column in this schema is either an id that fits in a JS number or a
// double, so parse them eagerly and keep the domain types clean.
types.setTypeParser(20, (value) => Number.parseInt(value, 10)); // int8
types.setTypeParser(1700, (value) => Number.parseFloat(value)); // numeric

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;

let pool: DbPool | undefined;

export function getPool(): DbPool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on('error', (err) => {
    process.stderr.write(`postgres pool error: ${err.message}\n`);
  });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end();
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>, existingPool?: DbPool): Promise<T> {
  const client = await (existingPool ?? getPool()).connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function pingDatabase(existingPool?: DbPool): Promise<boolean> {
  try {
    await (existingPool ?? getPool()).query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
