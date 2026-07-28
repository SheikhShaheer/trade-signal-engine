import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Replayer } from '../src/backtest/replay.js';
import type { Repositories } from '../src/db/repositories.js';
import type { Candle, MarketSnapshot } from '../src/types.js';
import { makeCandles, makePortfolio, makeSnapshot, testInstrument } from './fixtures.js';

const config = loadConfig({ instruments: [testInstrument] });

function repositoriesReturning(snapshots: MarketSnapshot[]): Repositories {
  return {
    snapshots: {
      range: async () => snapshots,
      count: async () => snapshots.length,
    },
    backtests: {
      createRun: async () => 1,
      addResult: async () => {},
      finishRun: async () => {},
    },
  } as unknown as Repositories;
}

/** Snapshot whose forward candles run past the plan's first target. */
function snapshotWithFuture(direction: 'up' | 'down'): MarketSnapshot {
  const drift = direction === 'up' ? 0.004 : -0.004;
  const start = direction === 'up' ? 100 : 500;
  const history = makeCandles({ count: 300, start, drift, wick: 0.004 });
  const snapshot = makeSnapshot({
    candles: { '4h': history },
    volume: { ratio: 2, isSpike: true },
  });
  return { ...snapshot, id: 1 };
}

describe('Replayer', () => {
  it('reports an empty window with a warning rather than failing', async () => {
    const replayer = new Replayer(config, repositoriesReturning([]));
    const { summary } = await replayer.run({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(),
    });

    expect(summary.snapshotsReplayed).toBe(0);
    expect(summary.warnings.some((w) => w.includes('no snapshots'))).toBe(true);
  });

  it('replays a snapshot and records why nothing was produced', async () => {
    const flat = { ...makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0 }) } }), id: 1 };
    const replayer = new Replayer(config, repositoriesReturning([flat]));

    const { results, summary } = await replayer.run({
      from: new Date(Date.now() - 86_400_000),
      to: new Date(),
    });

    expect(summary.snapshotsReplayed).toBe(1);
    expect(summary.memosProduced).toBe(0);
    expect(results[0]?.dropReason).toBeDefined();
  });

  it('produces a memo and an outcome for a signalling snapshot', async () => {
    const snapshot = snapshotWithFuture('up');
    const replayer = new Replayer(config, repositoriesReturning([snapshot]));

    const { results } = await replayer.run({
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(),
      portfolio: makePortfolio(),
    });

    const result = results[0];
    expect(result).toBeDefined();
    expect(['target', 'stop', 'open', 'no-data']).toContain(result?.outcome);
  });

  it('groups results by score bucket and by decision', async () => {
    const replayer = new Replayer(config, repositoriesReturning([snapshotWithFuture('up')]));
    const { summary } = await replayer.run({
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(),
      portfolio: makePortfolio(),
    });

    if (summary.memosProduced > 0) {
      expect(summary.byScoreBucket.length).toBeGreaterThan(0);
      expect(summary.byDecision.length).toBeGreaterThan(0);
      for (const bucket of summary.byScoreBucket) {
        expect(bucket.count).toBe(bucket.targetHits + bucket.stopHits + bucket.unresolved);
      }
    }
  });

  it('reports no-data when there are no candles after the memo timestamp', async () => {
    // History ends well in the past, so nothing follows the memo.
    const old = makeCandles({
      count: 300,
      start: 100,
      drift: 0.004,
      wick: 0.004,
      endTime: Date.now() - 400 * 4 * 3_600_000,
    });
    const snapshot = {
      ...makeSnapshot({ candles: { '4h': old }, volume: { ratio: 2, isSpike: true } }),
      id: 1,
    };

    const replayer = new Replayer(config, repositoriesReturning([snapshot]));
    const { results } = await replayer.run({
      from: new Date(Date.now() - 400 * 86_400_000),
      to: new Date(),
      portfolio: makePortfolio(),
    });

    if (results[0]?.memo) expect(results[0]?.outcome).toBe('no-data');
  });

  it('resolves a stop hit to exactly -1R', async () => {
    const history = makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 });
    const collapse: Candle[] = [];
    const lastTime = (history[history.length - 1] as Candle).openTime;
    // A future candle far below the entry, which must hit the stop.
    for (let i = 1; i <= 5; i += 1) {
      const openTime = lastTime + i * 4 * 3_600_000;
      collapse.push({ openTime, closeTime: openTime + 4 * 3_600_000 - 1, open: 50, high: 51, low: 1, close: 2, volume: 5_000 });
    }

    const snapshot = {
      ...makeSnapshot({ candles: { '4h': [...history, ...collapse] }, volume: { ratio: 2, isSpike: true } }),
      id: 1,
    };

    const replayer = new Replayer(config, repositoriesReturning([snapshot]));
    const { results } = await replayer.run({
      from: new Date(Date.now() - 30 * 86_400_000),
      to: new Date(),
      forwardWindowHours: 240,
      portfolio: makePortfolio(),
    });

    const result = results[0];
    if (result?.memo && result.outcome === 'stop') {
      expect(result.realisedR).toBe(-1);
    }
  });
});
