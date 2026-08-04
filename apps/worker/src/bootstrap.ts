import {
  Pipeline,
  PositionMonitor,
  createExecutionProvider,
  createBinanceTestnetClient,
  createMarketDataProvider,
  createNewsProvider,
  createLogger,
  createRepositories,
  getEnv,
  loadConfigFromEnv,
  getTestnetCredentials,
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
 * confirm the schema is present, and wire providers into the trading pipeline.
 */
export async function bootstrap(component: string): Promise<Bootstrapped> {
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL, { component });
  const config = loadConfigFromEnv();

  logger.info('configuration loaded', {
    instruments: config.instruments.length,
    timeframes: config.scanner.timeframes.join(','),
    equity: config.account.startingEquity,
    riskPerTradePct: config.account.riskPerTradePct,
    maxDrawdownPct: config.account.maxDrawdownPct,
    newsProvider: env.NEWS_PROVIDER,
    approveAt: config.scoring.thresholds.approve,
    watchlistAt: config.scoring.thresholds.watchlist,
    executionMode: config.execution.mode,
    autoDecisions: config.execution.autoDecisions.join(','),
    testnetConfigured: Boolean(getTestnetCredentials()),
  });

  if (!(await pingDatabase())) {
    throw new Error(
      `cannot reach Postgres at ${env.DATABASE_URL}. Start it with "npm run db:up", then "npm run db:migrate".`,
    );
  }
  await runMigrations(getPool(), logger);

  const repositories = createRepositories();
  await repositories.bot.syncExecutionMode(config.execution.mode);
  await repositories.bot.syncApproveThreshold(config.scoring.thresholds.approve);
  await repositories.bot.syncSignalTimeframe(config.volatility.atrTimeframe);

  const marketData = createMarketDataProvider(env, config.data);
  const news = createNewsProvider(env, config.data);

  for (const instrument of config.instruments) {
    await marketData.assertSymbolSupported(instrument.symbol);
  }
  logger.info('instrument symbols verified', { provider: marketData.name, count: config.instruments.length });

  const testnetCreds = getTestnetCredentials();
  const testnetClient = testnetCreds
    ? createBinanceTestnetClient({
        apiKey: testnetCreds.apiKey,
        apiSecret: testnetCreds.apiSecret,
        baseUrl: testnetCreds.baseUrl,
      })
    : undefined;

  const executor = createExecutionProvider({
    config,
    repositories,
    logger,
    client: testnetClient,
  });
  const positionMonitor = new PositionMonitor({
    config,
    repositories,
    marketData,
    executor,
    logger,
  });

  const pipeline = new Pipeline({
    config,
    repositories,
    marketData,
    news,
    executor,
    positionMonitor,
    logger,
  });
  return { config, logger, repositories, pipeline };
}
