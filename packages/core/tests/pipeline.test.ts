import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { Pipeline } from '../src/pipeline/pipeline.js';
import { Scheduler } from '../src/pipeline/scheduler.js';
import { StubNewsProvider } from '../src/providers/news-stub.js';
import type { MarketDataProvider, NewsProvider } from '../src/providers/types.js';
import type {
  Candle,
  DecisionMemo,
  MarketSnapshot,
  PipelineRunStats,
  ReviewStatus,
  RiskGateResult,
  SignalCandidate,
  TradePlan,
} from '../src/types.js';
import type { Repositories } from '../src/db/repositories.js';
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

/** In-memory stand-ins for the repositories, so the pipeline runs without Postgres. */
function makeFakeRepositories() {
  const state = {
    snapshots: [] as MarketSnapshot[],
    signals: [] as SignalCandidate[],
    plans: [] as TradePlan[],
    gateResults: [] as RiskGateResult[],
    memos: [] as DecisionMemo[],
    enqueued: [] as number[],
    /** memoId → queue row, mirroring what `review_queue` would hold. */
    queue: new Map<number, { status: ReviewStatus; memo: DecisionMemo; reviewedAt?: number }>(),
    finishedStats: undefined as PipelineRunStats | undefined,
  };

  const memoById = new Map<number, DecisionMemo>();
  let nextId = 1;
  const repositories = {
    runs: {
      start: async () => nextId++,
      finish: async (_runId: number, stats: PipelineRunStats) => {
        state.finishedStats = stats;
      },
      recent: async () => [],
    },
    snapshots: {
      insert: async (snapshot: MarketSnapshot) => {
        state.snapshots.push(snapshot);
        return nextId++;
      },
      latestFor: async () => undefined,
      range: async () => [],
      count: async () => state.snapshots.length,
    },
    signals: {
      insert: async (candidate: SignalCandidate) => {
        state.signals.push(candidate);
        return nextId++;
      },
    },
    plans: {
      insert: async (plan: TradePlan) => {
        state.plans.push(plan);
        return nextId++;
      },
    },
    riskGate: {
      insert: async (result: RiskGateResult) => {
        state.gateResults.push(result);
        return nextId++;
      },
    },
    memos: {
      insert: async (memo: DecisionMemo) => {
        state.memos.push(memo);
        const id = nextId++;
        memoById.set(id, memo);
        return id;
      },
      ranked: async () => [],
      byId: async () => undefined,
      decisionCounts: async () => ({ approved: 0, watchlist: 0, rejected: 0 }),
    },
    review: {
      // Mirrors the de-duplication the real repository does in SQL, so the
      // pipeline's handling of each outcome is exercised without Postgres.
      enqueue: async (
        memoId: number,
        _ttlMinutes: number,
        options: { supersedePendingDuplicates?: boolean; duplicateCooldownMinutes?: number } = {},
      ) => {
        const { supersedePendingDuplicates = true, duplicateCooldownMinutes = 0 } = options;
        const memo = memoById.get(memoId);
        if (!memo) throw new Error(`memo ${memoId} does not exist`);

        const sameIdea = [...state.queue.entries()].filter(
          ([id, row]) =>
            id !== memoId &&
            row.memo.instrument === memo.instrument &&
            row.memo.direction === memo.direction,
        );

        // Asked independently, as in the SQL: a suppressed or superseded row
        // must not hide an earlier human decision.
        const cooldownMs = duplicateCooldownMinutes * 60_000;
        const lastDecidedAt = sameIdea
          .filter(([, row]) => row.status === 'acknowledged' || row.status === 'dismissed')
          .reduce((latest, [, row]) => Math.max(latest, row.reviewedAt ?? 0), 0);
        if (lastDecidedAt > 0 && Date.now() - lastDecidedAt < cooldownMs) {
          state.queue.set(memoId, { status: 'suppressed', memo });
          return 'suppressed';
        }

        const stillPending = sameIdea.filter(([, row]) => row.status === 'pending');
        let outcome: 'queued' | 'superseded' = 'queued';
        if (stillPending.length > 0 && supersedePendingDuplicates) {
          for (const [, row] of stillPending) row.status = 'superseded';
          outcome = 'superseded';
        }

        state.queue.set(memoId, { status: 'pending', memo });
        state.enqueued.push(memoId);
        return outcome;
      },
      pending: async () => [],
      recordDecision: async () => ({ ok: true }),
      expireStale: async () => 0,
      auditLog: async () => [],
    },
    portfolio: {
      current: async () => makePortfolio(),
      openPositions: async () => [],
      recordState: async () => {},
    },
    newsCache: {
      get: async () => undefined,
      put: async () => {},
    },
    backtests: {
      createRun: async () => nextId++,
      addResult: async () => {},
      finishRun: async () => {},
    },
  } as unknown as Repositories;

  return { repositories, state };
}

const config = loadConfig({
  instruments: [testInstrument],
  data: { requestSpacingMs: 0 },
});

/**
 * The stub provider varies its headlines by hour, which moves the news component
 * of the score. De-duplication tests assert on exact queue counts, so they use a
 * provider with no news at all to stay deterministic whatever time they run at.
 */
const noNews: NewsProvider = {
  name: 'none',
  async getNews() {
    return [];
  },
};

describe('Pipeline', () => {
  it('stores a snapshot for every scanned instrument even with no signal', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0 })),
      news: new StubNewsProvider(),
    });

    const stats = await pipeline.run('once');
    expect(stats.snapshotsStored).toBe(1);
    expect(state.snapshots).toHaveLength(1);
  });

  it('explains why an instrument produced nothing', async () => {
    const { repositories } = makeFakeRepositories();
    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0 })),
      news: new StubNewsProvider(),
    });

    const stats = await pipeline.run('once');
    expect(stats.signalsDetected).toBe(0);
    expect(stats.drops).toHaveLength(1);
    expect(stats.drops[0]?.stage).toBe('detector');
    expect(stats.drops[0]?.reason).toMatch(/no detector produced/);
  });

  it('runs a trending market through to a memo and the review queue', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 })),
      news: new StubNewsProvider(),
    });

    const stats = await pipeline.run('once');

    expect(stats.signalsDetected).toBeGreaterThan(0);
    if (stats.plansBuilt > 0) {
      expect(state.gateResults).toHaveLength(stats.plansBuilt);
      expect(state.memos).toHaveLength(stats.memosCreated);
      // Only memos that passed the gate and cleared the cutoff reach the queue.
      expect(stats.queuedForReview + stats.suppressedDuplicates).toBe(stats.approved + stats.watchlist);
    }
  });

  it('supersedes a pending memo instead of queueing the same idea twice', async () => {
    const { repositories, state } = makeFakeRepositories();
    const deps = {
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 })),
      news: noNews,
    };

    const first = await new Pipeline(deps).run('once');
    expect(first.queuedForReview).toBeGreaterThan(0);

    const second = await new Pipeline(deps).run('once');

    expect(second.supersededDuplicates).toBe(second.queuedForReview);
    // The reviewer sees one live item per idea however often the scan repeats.
    const pendingCount = [...state.queue.values()].filter((r) => r.status === 'pending').length;
    expect(pendingCount).toBe(first.queuedForReview);
    // Nothing is discarded: the older memo is still there, marked superseded.
    expect([...state.queue.values()].filter((r) => r.status === 'superseded')).toHaveLength(
      second.supersededDuplicates,
    );
  });

  it('does not re-queue an idea a human decided on inside the cooldown', async () => {
    const { repositories, state } = makeFakeRepositories();
    const deps = {
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 })),
      news: noNews,
    };

    const first = await new Pipeline(deps).run('once');
    expect(first.queuedForReview).toBeGreaterThan(0);

    // Stand in for a human dismissing everything currently awaiting review.
    for (const row of state.queue.values()) {
      if (row.status === 'pending') {
        row.status = 'dismissed';
        row.reviewedAt = Date.now();
      }
    }

    const second = await new Pipeline(deps).run('once');

    expect(second.suppressedDuplicates).toBeGreaterThan(0);
    expect(second.queuedForReview).toBe(0);
    // A dismissal is not undone by the next scan.
    expect([...state.queue.values()].some((r) => r.status === 'pending')).toBe(false);

    // The scan after that is the one that used to slip through: the suppressed
    // row it created was the newest, so a naive lookup stopped there and never
    // saw the dismissal behind it.
    const third = await new Pipeline(deps).run('once');
    expect(third.suppressedDuplicates).toBe(second.suppressedDuplicates);
    expect(third.queuedForReview).toBe(0);
    expect([...state.queue.values()].some((r) => r.status === 'pending')).toBe(false);
  });

  it('writes risk-gate audit rows for blocked plans too', async () => {
    const { repositories, state } = makeFakeRepositories();
    // A breached drawdown blocks everything, so any plan built gets an audit row
    // but nothing is queued.
    (repositories.portfolio as unknown as { current: () => Promise<unknown> }).current = async () =>
      makePortfolio({ equity: 8_000, peakEquity: 10_000 });

    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 100, drift: 0.004, wick: 0.004 })),
      news: new StubNewsProvider(),
    });

    const stats = await pipeline.run('once');
    expect(stats.queuedForReview).toBe(0);
    if (stats.plansBuilt > 0) {
      expect(stats.riskGateBlocked).toBe(stats.plansBuilt);
      expect(state.gateResults.every((r) => !r.overallPass)).toBe(true);
      expect(state.memos.every((m) => m.decision === 'rejected')).toBe(true);
    }
  });

  it('never queues a memo whose risk gate failed', async () => {
    const { repositories, state } = makeFakeRepositories();
    (repositories.portfolio as unknown as { current: () => Promise<unknown> }).current = async () =>
      makePortfolio({ equity: 8_000, peakEquity: 10_000 });

    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 100, drift: 0.005, wick: 0.004 })),
      news: new StubNewsProvider(),
    });

    await pipeline.run('once');
    expect(state.enqueued).toHaveLength(0);
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

    const pipeline = new Pipeline({ config, repositories, marketData: failing, news: new StubNewsProvider() });
    const stats = await pipeline.run('once');

    expect(stats.errors.some((e) => e.includes('exchange unreachable'))).toBe(true);
    expect(stats.instrumentsScanned).toBe(0);
    expect(stats.finishedAt).toBeDefined();
  });

  it('always finalises the run record', async () => {
    const { repositories, state } = makeFakeRepositories();
    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0 })),
      news: new StubNewsProvider(),
    });

    await pipeline.run('once');
    expect(state.finishedStats).toBeDefined();
    expect(state.finishedStats?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('evaluates a snapshot without persistence for replay and tests', () => {
    const { repositories } = makeFakeRepositories();
    const pipeline = new Pipeline({
      config,
      repositories,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0 })),
      news: new StubNewsProvider(),
    });

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
    // A manually-released gate rather than a timer, so the in-flight run can be
    // completed before fake timers are torn down.
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
