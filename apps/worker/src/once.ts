import { closePool } from '@tse/core';
import { bootstrap } from './bootstrap.js';

/** Single pipeline pass, for verifying a fresh install or debugging a stage. */
async function main(): Promise<void> {
  const { pipeline, repositories } = await bootstrap('pipeline-once');
  const stats = await pipeline.run('once');

  const out = process.stdout;
  out.write('\n=== Pipeline run ===\n');
  out.write(`duration:          ${(stats.durationMs / 1000).toFixed(1)}s\n`);
  out.write(`instruments:       ${stats.instrumentsScanned}\n`);
  out.write(`signals detected:  ${stats.signalsDetected}\n`);
  out.write(`plans built:       ${stats.plansBuilt}\n`);
  out.write(`risk gate passed:  ${stats.riskGatePassed}\n`);
  out.write(`risk gate blocked: ${stats.riskGateBlocked}\n`);
  out.write(`memos:             ${stats.memosCreated} (approved ${stats.approved}, watchlist ${stats.watchlist}, rejected ${stats.rejected})\n`);
  out.write(
    `executed:          ${stats.executed}` +
      (stats.executionSkipped > 0 ? ` (${stats.executionSkipped} skipped)` : '') +
      '\n',
  );
  if (stats.positionsClosed > 0) {
    out.write(`positions closed:  ${stats.positionsClosed}\n`);
  }

  if (stats.drops.length > 0) {
    out.write('\nWhy instruments did not trade\n');
    for (const drop of stats.drops) {
      out.write(`  ${drop.instrument.padEnd(10)} [${drop.stage}] ${drop.reason}\n`);
    }
  }
  if (stats.errors.length > 0) {
    out.write('\nErrors\n');
    for (const error of stats.errors) out.write(`  ${error}\n`);
  }

  const ranked = await repositories.memos.ranked({ limit: 10, latestPerIdea: true });
  if (ranked.length > 0) {
    out.write('\n=== Ranked memos (best first) ===\n');
    for (const memo of ranked) {
      out.write(
        `  ${memo.score.toFixed(2).padStart(5)}  ${memo.decision.padEnd(10)} ${memo.instrument.padEnd(9)} ` +
          `${memo.direction.padEnd(5)} entry ${memo.tradePlan.entryZone.low}-${memo.tradePlan.entryZone.high} ` +
          `stop ${memo.tradePlan.stopLoss} tp1 ${memo.tradePlan.targets[0]} R:R ${memo.tradePlan.riskRewardRatio}\n`,
      );
    }
    out.write('\nPaper bot trades approved memos automatically. See dashboard → Trades.\n');
  } else {
    out.write('\nNo memos yet. This is normal on a quiet market or a first run.\n');
  }
}

main()
  .catch((error: Error) => {
    process.stderr.write(`pipeline run failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
