import { silentLogger, type Logger } from '../logging/logger.js';

export interface SchedulerOptions {
  intervalSec: number;
  /** Random 0..jitterSec delay added to each tick so runs do not align exactly. */
  jitterSec: number;
  /** A tick still running after this long is reported; the next tick is skipped. */
  maxRunDurationSec: number;
  runImmediately?: boolean;
  logger?: Logger;
}

/**
 * Long-running interval scheduler with overlap protection.
 *
 * A tick that overruns causes the next one to be skipped rather than queued. In
 * a market scanner, two overlapping runs would double-count exposure against the
 * same portfolio snapshot, and a backlog of stale ticks is worse than a gap.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private readonly logger: Logger;
  private currentRunStartedAt: number | undefined;
  private tickCount = 0;
  private skippedCount = 0;

  constructor(
    private readonly options: SchedulerOptions,
    private readonly task: () => Promise<void>,
  ) {
    this.logger = (options.logger ?? silentLogger).child({ component: 'scheduler' });
  }

  start(): void {
    if (this.timer) throw new Error('scheduler already started');
    this.stopped = false;
    this.logger.info('scheduler started', {
      intervalSec: this.options.intervalSec,
      jitterSec: this.options.jitterSec,
    });

    if (this.options.runImmediately !== false) {
      void this.tick();
    }
    this.timer = setInterval(() => void this.tick(), this.options.intervalSec * 1000);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    if (this.running) {
      this.skippedCount += 1;
      const elapsedSec = this.currentRunStartedAt ? (Date.now() - this.currentRunStartedAt) / 1000 : 0;
      this.logger.warn('skipping tick, previous run still in flight', {
        elapsedSec: Math.round(elapsedSec),
        maxRunDurationSec: this.options.maxRunDurationSec,
        skippedTotal: this.skippedCount,
      });
      return;
    }

    this.running = true;
    this.currentRunStartedAt = Date.now();
    this.tickCount += 1;

    try {
      const jitterMs = this.options.jitterSec > 0 ? Math.floor(Math.random() * this.options.jitterSec * 1000) : 0;
      if (jitterMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
      if (this.stopped) return;

      await this.task();

      const durationSec = (Date.now() - (this.currentRunStartedAt as number)) / 1000;
      if (durationSec > this.options.maxRunDurationSec) {
        this.logger.warn('tick exceeded its budget; consider a longer interval or fewer instruments', {
          durationSec: Math.round(durationSec),
          maxRunDurationSec: this.options.maxRunDurationSec,
        });
      }
    } catch (error) {
      // A failed tick must never kill the loop: the whole point is to keep
      // running 24/7 through transient API and database failures.
      this.logger.error('scheduled task threw', { error: (error as Error).message });
    } finally {
      this.running = false;
      this.currentRunStartedAt = undefined;
    }
  }

  /** Stops scheduling and waits for an in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    while (this.running) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    this.logger.info('scheduler stopped', { ticks: this.tickCount, skipped: this.skippedCount });
  }

  get stats(): { ticks: number; skipped: number; running: boolean } {
    return { ticks: this.tickCount, skipped: this.skippedCount, running: this.running };
  }
}
