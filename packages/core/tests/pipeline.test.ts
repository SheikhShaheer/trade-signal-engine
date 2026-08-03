import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { Scheduler } from '../src/pipeline/scheduler.js';
import { StubNewsProvider } from '../src/providers/news-stub.js';
import type { MarketDataProvider, NewsProvider } from '../src/providers/types.js';
import type { Candle } from '../src/types.js';
import { makeFakeRepositories, makeTestPipelineDeps } from './fake-repos.js';
import { makeCandles, makePortfolio, testInstrument } from './fixtures.js';

class FakeMarketData implements MarketDataProvider {
  readonly name = 'fake';
  constructor(private readonly candles: Candle[]) {}
  async getCandles(): Promise<Candle[]> {
    return this.candles;
  }
  async getLastPrice(): Promise<number> {
    return (this.candles[this.candles.length - 1] as Candle).close;
  }
  async assertSymbolSupported(): Promise<void> {}
}

const config = loadConfig({
  instruments: [testInstrument],
  data: { requestSpacingMs: 0 },
});

const noNews: NewsProvider = {
  name: 'none',
  async getNews() {
    return [];
  },
};

function deps(repositories: ReturnType<typeof makeFakeRepositories>['repositories'], candles: Candle[], news: NewsProvider = new StubNewsProvider()) {
  return makeTestPipelineDeps(repositories, new FakeMarketData(candles), news, config);
}

describe('Pipeline', () => {
  it('stores a snapshot for every scanned instrument even with no signal', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline(deps(repositories, makeCandles({ count: 300, drift: 0 })));

    const stats = await pipeline.run('once');
    expect(stats.snapshotsStored).toBe(1);
    expect(state.snapshots).toHaveLength(1);
  });

  it('explains why an instrument produced nothing', async () => {
    const { repositories } = makeFakeRepositories();
    const pipeline = new Pipeline(deps(repositories, makeCandles({ count: 300, drift: 0 })));

    const stats = await pipeline.run('once');
    expect(stats.signalsDetected).toBe(0);
    expect(stats.drops).toHaveLength(1);
    expect(stats.drops[0]?.stage).toBe('detector');
    expect(stats.drops[0]?.reason).toMatch(/no detector produced/);
  });

  it('runs a trending market through to memos and executes approved trades', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline(
      deps(repositories, makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 }), noNews),
    );

    const stats = await pipeline.run('once');

    expect(stats.signalsDetected).toBeGreaterThan(0);
    if (stats.plansBuilt > 0) {
      expect(state.gateResults).toHaveLength(stats.plansBuilt);
      expect(state.memos).toHaveLength(stats.memosCreated);
      if (stats.approved > 0) {
        expect(stats.executed + stats.executionSkipped).toBeGreaterThan(0);
      }
    }
  });

  it('skips execution when bot is paused', async () => {
    const { repositories, state } = makeFakeRepositories();
    state.paused = true;
    const pipeline = new Pipeline(
      deps(repositories, makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 }), noNews),
    );

    const stats = await pipeline.run('once');
    if (stats.approved > 0) {
      expect(stats.executed).toBe(0);
      expect(stats.executionSkipped).toBeGreaterThan(0);
      expect(state.orders).toHaveLength(0);
    }
  });

  it('does not re-trade an idea inside the cooldown', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipelineDeps = deps(
      repositories,
      makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 }),
      noNews,
    );
    const pipeline = new Pipeline(pipelineDeps);

    const first = await pipeline.run('once');
    const firstExecuted = first.executed;

    const second = await pipeline.run('once');
    expect(second.executionSkipped).toBeGreaterThanOrEqual(firstExecuted > 0 ? 1 : 0);
    expect(state.orders.length).toBe(firstExecuted);
  });

  it('writes risk-gate audit rows for blocked plans too', async () => {
    const { repositories, state } = makeFakeRepositories();
    (repositories.portfolio as unknown as { current: () => Promise<unknown> }).current = async () =>
      makePortfolio({ equity: 8_000, peakEquity: 10_000 });

    const pipeline = new Pipeline(
      deps(repositories, makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 })),
    );

    const stats = await pipeline.run('once');
    expect(stats.executed).toBe(0);
    if (stats.plansBuilt > 0) {
      expect(stats.riskGateBlocked).toBe(stats.plansBuilt);
      expect(state.gateResults.every((r) => !r.overallPass)).toBe(true);
      expect(state.memos.every((m) => m.decision === 'rejected')).toBe(true);
    }
  });

  it('never executes a memo whose risk gate failed', async () => {
    const { repositories, state } = makeFakeRepositories();
    (repositories.portfolio as unknown as { current: () => Promise<unknown> }).current = async () =>
      makePortfolio({ equity: 8_000, peakEquity: 10_000 });

    const pipeline = new Pipeline(
      deps(repositories, makeCandles({ count: 300, start: 100, drift: 0.005, wick: 0.004 })),
    );

    await pipeline.run('once');
    expect(state.orders).toHaveLength(0);
  });

  it('records a scan failure without aborting the run', async () => {
    const { repositories } = makeFakeRepositories();
    const failing: MarketDataProvider = {
      name: 'failing',
      async getCandles() {
        throw new Error('exchange unreachable');
      },
      async getLastPrice() {
        return 1;
      },
      async assertSymbolSupported() {},
    };

    const pipeline = new Pipeline(makeTestPipelineDeps(repositories, failing, new StubNewsProvider(), config));
    const stats = await pipeline.run('once');

    expect(stats.errors.some((e) => e.includes('exchange unreachable'))).toBe(true);
    expect(stats.instrumentsScanned).toBe(0);
    expect(stats.finishedAt).toBeDefined();
  });

  it('always finalises the run record', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline(deps(repositories, makeCandles({ count: 300, drift: 0 })));

    await pipeline.run('once');
    expect(state.finishedStats).toBeDefined();
    expect(state.finishedStats?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('evaluates a snapshot without persistence for replay and tests', () => {
    const { repositories } = makeFakeRepositories();
    const pipeline = new Pipeline(deps(repositories, makeCandles({ count: 300, drift: 0 })));

    const result = pipeline.evaluateSnapshot(
      {
        instrument: testInstrument.symbol,
        label: 'Bitcoin',
        correlationGroup: 'crypto-major',
        capturedAt: new Date().toISOString(),
        price: 100,
        volume: { current: 1, rollingAverage: 1, ratio: 1, isSpike: false },
        timeframes: {},
        higherTimeframeTrend: 'flat',
        keyLevels: [],
        setupCandidates: {
          touchingResistance: false,
          touchingSupport: false,
          touchingVwap: false,
          nearRecentHigh: false,
          nearRecentLow: false,
          volumeSpike: false,
          any: false,
        },
        news: { items: [], aggregateSentiment: 0, itemCount: 0, provider: 'test' },
        warnings: [],
      },
      makePortfolio(),
    );

    expect('drop' in result).toBe(true);
  });
});

describe('Scheduler', () => {
  it('runs immediately and then on the interval', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new Scheduler(
      { intervalSec: 1, jitterSec: 0, maxRunDurationSec: 10 },
      async () => {
        runs += 1;
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runs).toBe(4);

    vi.useRealTimers();
    await scheduler.stop();
  });

  it('skips a tick rather than overlapping a slow run', async () => {
    vi.useFakeTimers();
    let started = 0;
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduler = new Scheduler(
      { intervalSec: 1, jitterSec: 0, maxRunDurationSec: 10 },
      async () => {
        started += 1;
        await inFlight;
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(started).toBe(1);
    expect(scheduler.stats.skipped).toBeGreaterThanOrEqual(3);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.stats.running).toBe(false);

    vi.useRealTimers();
    await scheduler.stop();
  });

  it('keeps running after a task throws', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const scheduler = new Scheduler(
      { intervalSec: 1, jitterSec: 0, maxRunDurationSec: 10 },
      async () => {
        runs += 1;
        throw new Error('transient failure');
      },
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(runs).toBe(3);
    vi.useRealTimers();
    await scheduler.stop();
  });

  it('refuses to start twice', () => {
    const scheduler = new Scheduler(
      { intervalSec: 60, jitterSec: 0, maxRunDurationSec: 10, runImmediately: false },
      async () => {},
    );
    scheduler.start();
    expect(() => scheduler.start()).toThrow(/already started/);
    void scheduler.stop();
  });
});
