import { getEnv } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { runMigrations } from '../migrate.js';
import { closePool, getPool, pingDatabase } from '../pool.js';

const logger = createLogger(getEnv().LOG_LEVEL, { cmd: 'migrate' });

async function main(): Promise<void> {
  const pool = getPool();
  if (!(await pingDatabase(pool))) {
    throw new Error(
      `cannot reach Postgres at ${getEnv().DATABASE_URL}. Start it with "npm run db:up" and retry.`,
    );
  }
  const applied = await runMigrations(pool, logger);
  logger.info('migrations complete', { applied: applied.length });
}

main()
  .catch((error: Error) => {
    logger.error('migration failed', { error });
    process.exitCode = 1;
  })
  .finally(() => closePool());
