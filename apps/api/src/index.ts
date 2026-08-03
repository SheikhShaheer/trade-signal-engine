import { createServer } from 'node:http';
import {
  closePool,
  createLogger,
  createRepositories,
  getEnv,
  getPool,
  getTestnetCredentials,
  loadConfigFromEnv,
  pingDatabase,
  runMigrations,
} from '@tse/core';
import { buildRoutes } from './routes.js';

/**
 * HTTP API for the paper-trading bot dashboard.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL, { component: 'api' });
  const config = loadConfigFromEnv();

  if (!(await pingDatabase())) {
    throw new Error(`cannot reach Postgres at ${env.DATABASE_URL}. Start it with "npm run db:up".`);
  }
  await runMigrations(getPool(), logger);

  const router = buildRoutes({
    config,
    repositories: createRepositories(),
    defaultReviewer: env.REVIEWER_NAME,
  });

  const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    `http://${env.API_HOST}:${env.API_PORT}`,
  ];

  const server = createServer(router.handle(allowedOrigins));

  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info('api listening', {
      url: `http://${env.API_HOST}:${env.API_PORT}`,
      autoExecution: true,
      mode: config.execution.mode,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error: Error) => {
  process.stderr.write(`api failed to start: ${error.message}\n`);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
