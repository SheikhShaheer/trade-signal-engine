import { loadConfig } from '../../config/index.js';
import { getEnv } from '../../config/env.js';
import { createLogger } from '../../logging/logger.js';
import { closePool, getPool } from '../pool.js';
import { createRepositories } from '../repositories.js';

/**
 * Seeds the portfolio row the risk gate reads. Open positions are intentionally
 * left empty: the operator records those manually, because this system has no
 * way to open one.
 */
const logger = createLogger(getEnv().LOG_LEVEL, { cmd: 'seed' });

async function main(): Promise<void> {
  const config = loadConfig();
  const repos = createRepositories();
  const pool = getPool();

  const { rows } = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM portfolio_state');
  if ((rows[0]?.count ?? 0) > 0) {
    logger.info('portfolio state already present, leaving it untouched');
    return;
  }

  await repos.portfolio.recordState(config.account.startingEquity, config.account.startingEquity, 0);
  logger.info('seeded portfolio state', {
    equity: config.account.startingEquity,
    riskPerTradePct: config.account.riskPerTradePct,
    maxDrawdownPct: config.account.maxDrawdownPct,
  });
}

main()
  .catch((error: Error) => {
    logger.error('seed failed', { error });
    process.exitCode = 1;
  })
  .finally(() => closePool());
