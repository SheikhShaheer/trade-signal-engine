import {
  Pipeline,
  createMarketDataProvider,
  createNewsProvider,
  createLogger,
  createRepositories,
  getEnv,
  loadConfig,
  pingDatabase,
  runMigrations,
  getPool,
  type EngineConfig,
  type Logger,
  type Repositories,
} from '@tse/core';

export interface Bootstrapped {
  config: EngineConfig;
  logger: Logger;
  repositories: Repositories;
  pipeline: Pipeline;
}

/**
 * Shared start-up for the worker entry points: validate config and environment,
 * confirm the schema is present, and wire the providers into the pipeline.
 *
 * Failing loudly here is intentional. A scanner that starts with a broken
 * config and silently produces no signals is worse than one that refuses to
 * start.
 */
export async function bootstrap(component: string): Promise<Bootstrapped> {
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL, { component });
  const config = loadConfig();

  logger.info('configuration loaded', {
    instruments: config.instruments.length,
    timeframes: config.scanner.timeframes.join(','),
    equity: config.account.startingEquity,
    riskPerTradePct: config.account.riskPerTradePct,
    maxDrawdownPct: config.account.maxDrawdownPct,
    newsProvider: env.NEWS_PROVIDER,
    approveAt: config.scoring.thresholds.approve,
    watchlistAt: config.scoring.thresholds.watchlist,
  });

  if (!(await pingDatabase())) {
    throw new Error(
      `cannot reach Postgres at ${env.DATABASE_URL}. Start it with "npm run db:up", then "npm run db:migrate".`,
    );
  }
  await runMigrations(getPool(), logger);

  const repositories = createRepositories();
  const marketData = createMarketDataProvider(env, config.data);
  const news = createNewsProvider(env, config.data);

  // Fail fast on a typo in the instrument list rather than logging a scan
  // failure every five minutes forever.
  for (const instrument of config.instruments) {
    await marketData.assertSymbolSupported(instrument.symbol);
  }
  logger.info('instrument symbols verified', { provider: marketData.name, count: config.instruments.length });

  const pipeline = new Pipeline({ config, repositories, marketData, news, logger });
  return { config, logger, repositories, pipeline };
}
