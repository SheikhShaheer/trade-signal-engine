import { Scheduler, closePool } from '@tse/core';
import { bootstrap } from './bootstrap.js';

/**
 * The 24/7 worker. A long-running process, not a one-shot script: it ticks on
 * the configured interval, survives transient provider and database failures,
 * and shuts down cleanly on SIGINT/SIGTERM so an in-flight run is never left
 * half-written.
 */
async function main(): Promise<void> {
  const { config, logger, pipeline } = await bootstrap('worker');

  const scheduler = new Scheduler(
    {
      intervalSec: config.schedule.pipelineIntervalSec,
      jitterSec: config.schedule.jitterSec,
      maxRunDurationSec: config.schedule.maxRunDurationSec,
      logger,
    },
    async () => {
      await pipeline.run('live');
    },
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested, waiting for the current run to finish', { signal });
    await scheduler.stop();
    await closePool();
    logger.info('worker stopped cleanly');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // An unhandled rejection inside a tick would otherwise kill a process that is
  // supposed to run for weeks.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });

  scheduler.start();
  logger.info('worker running; paper trading bot active', {
    intervalSec: config.schedule.pipelineIntervalSec,
    mode: config.execution.mode,
  });
}

main().catch(async (error: Error) => {
  process.stderr.write(`worker failed to start: ${error.message}\n`);
  await closePool().catch(() => {});
  process.exitCode = 1;
});
