import { getEnv } from '../config/env.js';
import { loadConfig } from '../config/index.js';
import { closePool, pingDatabase } from '../db/pool.js';
import { createRepositories } from '../db/repositories.js';
import { createLogger } from '../logging/logger.js';
import { Replayer, type BucketStats } from './replay.js';

/**
 * Replays stored snapshots through stages 2-6 and reports whether the score
 * actually predicted anything.
 *
 * Usage: npm run backtest -- [--days 7] [--instruments BTCUSDT,ETHUSDT]
 *                            [--forward-hours 72] [--persist] [--label name]
 */

interface Args {
  days: number;
  instruments: string[] | undefined;
  forwardHours: number;
  persist: boolean;
  label: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { days: 7, instruments: undefined, forwardHours: 72, persist: false, label: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--days':
        args.days = Number.parseFloat(next ?? '7');
        i += 1;
        break;
      case '--instruments':
        args.instruments = (next ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        i += 1;
        break;
      case '--forward-hours':
        args.forwardHours = Number.parseFloat(next ?? '72');
        i += 1;
        break;
      case '--label':
        args.label = next;
        i += 1;
        break;
      case '--persist':
        args.persist = true;
        break;
      default:
        break;
    }
  }
  if (!Number.isFinite(args.days) || args.days <= 0) throw new Error('--days must be a positive number');
  if (!Number.isFinite(args.forwardHours) || args.forwardHours <= 0) {
    throw new Error('--forward-hours must be a positive number');
  }
  return args;
}

function formatTable(rows: readonly BucketStats[]): string {
  const header = ['bucket', 'count', 'targets', 'stops', 'unresolved', 'hit rate', 'mean R'];
  const body = rows.map((r) => [
    r.bucket,
    String(r.count),
    String(r.targetHits),
    String(r.stopHits),
    String(r.unresolved),
    r.hitRate === undefined ? '-' : `${(r.hitRate * 100).toFixed(0)}%`,
    r.meanRealisedR === undefined ? '-' : r.meanRealisedR.toFixed(2),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)));
  const line = (cells: readonly string[]) => cells.map((c, i) => c.padEnd(widths[i] as number)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const logger = createLogger(env.LOG_LEVEL, { cmd: 'backtest' });
  const config = loadConfig();

  if (!(await pingDatabase())) {
    throw new Error(`cannot reach Postgres at ${env.DATABASE_URL}. Start it with "npm run db:up".`);
  }

  const repositories = createRepositories();
  const total = await repositories.snapshots.count();
  logger.info('starting replay', {
    days: args.days,
    forwardHours: args.forwardHours,
    snapshotsInDb: total,
    instruments: args.instruments?.join(',') ?? 'all',
  });

  const to = new Date();
  const from = new Date(to.getTime() - args.days * 86_400_000);

  const replayer = new Replayer(config, repositories);
  const { summary } = await replayer.run({
    from,
    to,
    instruments: args.instruments,
    forwardWindowHours: args.forwardHours,
    persist: args.persist,
    label: args.label,
    logger,
  });

  const out = process.stdout;
  out.write('\n=== Replay summary ===\n');
  out.write(`window:            ${from.toISOString()} → ${to.toISOString()}\n`);
  out.write(`snapshots:         ${summary.snapshotsReplayed}\n`);
  out.write(`memos produced:    ${summary.memosProduced}\n`);
  out.write(`  approved:        ${summary.approved}\n`);
  out.write(`  watchlist:       ${summary.watchlist}\n`);
  out.write(`  rejected:        ${summary.rejected}\n`);
  out.write(`resolved outcomes: ${summary.resolved}\n`);
  out.write(
    `score↔outcome r:   ${summary.scoreOutcomeCorrelation === undefined ? 'n/a (too few resolved outcomes)' : summary.scoreOutcomeCorrelation.toFixed(3)}\n`,
  );

  if (summary.byScoreBucket.length > 0) {
    out.write('\nBy score bucket\n');
    out.write(`${formatTable(summary.byScoreBucket)}\n`);
  }
  if (summary.byDecision.length > 0) {
    out.write('\nBy decision\n');
    out.write(`${formatTable(summary.byDecision)}\n`);
  }
  for (const warning of summary.warnings) out.write(`\nwarning: ${warning}\n`);

  out.write(
    '\nRead this as a sanity check, not a P&L: higher score buckets should show a better hit rate and mean R\n' +
      'than lower ones. If they do not, the weights in config/default.ts need revisiting before the score is\n' +
      'trusted. Stops are assumed to hit first when a candle spans both levels.\n',
  );
}

main()
  .catch((error: Error) => {
    process.stderr.write(`backtest failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
