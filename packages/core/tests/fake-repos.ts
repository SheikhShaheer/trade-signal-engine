import type { Repositories } from '../src/db/repositories.js';
import { createExecutionProvider, PaperExecutionProvider } from '../src/execution/index.js';
import type { PositionMonitor } from '../src/execution/monitor.js';
import type {
  DecisionMemo,
  Direction,
  PipelineRunStats,
  ReviewStatus,
  RiskGateResult,
  SignalCandidate,
  TradePlan,
  MarketSnapshot,
} from '../src/types.js';
import { loadConfig } from '../src/config/index.js';
import { makePortfolio } from './fixtures.js';

export interface FakeRepoState {
  snapshots: MarketSnapshot[];
  signals: SignalCandidate[];
  plans: TradePlan[];
  gateResults: RiskGateResult[];
  memos: DecisionMemo[];
  enqueued: number[];
  queue: Map<number, { status: ReviewStatus; memo: DecisionMemo; reviewedAt?: number }>;
  finishedStats: PipelineRunStats | undefined;
  orders: { memoId: number; instrument: string; direction: Direction; at: number }[];
  positions: {
    id: number;
    instrument: string;
    direction: Direction;
    quantity: number;
    entryPrice: number;
    stopLoss: number;
    takeProfit?: number;
    closed: boolean;
    markPrice?: number;
    unrealisedPnl?: number;
  }[];
  paused: boolean;
  approveThreshold: number;
  signalTimeframe: string;
  events: string[];
  equity: number;
  dayPnl: number;
}

/** In-memory stand-ins for repositories, so the pipeline runs without Postgres. */
export function makeFakeRepositories(): { repositories: Repositories; state: FakeRepoState } {
  const state: FakeRepoState = {
    snapshots: [],
    signals: [],
    plans: [],
    gateResults: [],
    memos: [],
    enqueued: [],
    queue: new Map(),
    finishedStats: undefined,
    orders: [],
    positions: [],
    paused: false,
    approveThreshold: 7.5,
    signalTimeframe: '4h',
    events: [],
    equity: 10_000,
    dayPnl: 0,
  };

  const memoById = new Map<number, DecisionMemo>();
  let nextId = 1;
  let nextPositionId = 1;

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
      enqueue: async () => 'queued' as const,
      pending: async () => [],
      recordDecision: async () => ({ ok: true }),
      expireStale: async () => 0,
      auditLog: async () => [],
      recentHumanDismissal: async (instrument: string, direction: Direction, cooldownMinutes: number) => {
        const cooldownMs = cooldownMinutes * 60_000;
        for (const [, row] of state.queue) {
          if (
            row.memo.instrument === instrument &&
            row.memo.direction === direction &&
            row.status === 'dismissed' &&
            row.reviewedAt &&
            Date.now() - row.reviewedAt < cooldownMs
          ) {
            return true;
          }
        }
        return false;
      },
    },
    portfolio: {
      current: async () => ({
        ...makePortfolio({ equity: state.equity, dayRealisedPnl: state.dayPnl }),
        openPositions: state.positions
          .filter((p) => !p.closed)
          .map((p) => ({
            id: p.id,
            instrument: p.instrument,
            correlationGroup: 'crypto-major',
            direction: p.direction,
            quantity: p.quantity,
            entryPrice: p.entryPrice,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            notional: p.entryPrice * p.quantity,
            openedAt: new Date().toISOString(),
            source: 'bot' as const,
            markPrice: p.markPrice,
            unrealisedPnl: p.unrealisedPnl,
          })),
      }),
      openPositions: async () => [],
      openBotPositions: async () =>
        state.positions
          .filter((p) => !p.closed)
          .map((p) => ({
            id: p.id,
            instrument: p.instrument,
            correlationGroup: 'crypto-major',
            direction: p.direction,
            quantity: p.quantity,
            entryPrice: p.entryPrice,
            stopLoss: p.stopLoss,
            takeProfit: p.takeProfit,
            notional: p.entryPrice * p.quantity,
            openedAt: new Date().toISOString(),
            source: 'bot' as const,
            markPrice: p.markPrice,
            unrealisedPnl: p.unrealisedPnl,
          })),
      updatePositionMark: async (positionId: number, markPrice: number, unrealisedPnl: number) => {
        const pos = state.positions.find((p) => p.id === positionId);
        if (pos) {
          pos.markPrice = markPrice;
          pos.unrealisedPnl = unrealisedPnl;
        }
      },
      recordState: async (equity: number, _peak: number, dayPnl: number) => {
        state.equity = equity;
        state.dayPnl = dayPnl;
      },
      applyRealisedPnl: async (pnl: number) => {
        state.equity += pnl;
        state.dayPnl += pnl;
        return repositories.portfolio.current();
      },
    },
    execution: {
      isPaused: async () => state.paused,
      setPaused: async (paused: boolean) => {
        state.paused = paused;
      },
      logEvent: async (input: { eventType: string; detail?: string }) => {
        state.events.push(`${input.eventType}:${input.detail ?? ''}`);
      },
      recentTradeOnIdea: async (instrument: string, direction: Direction, cooldownMinutes: number) => {
        const cutoff = Date.now() - cooldownMinutes * 60_000;
        return state.orders.some(
          (o) => o.instrument === instrument && o.direction === direction && o.at >= cutoff,
        );
      },
      createEntry: async (input: {
        memoId: number;
        instrument: string;
        direction: Direction;
        quantity: number;
        fillPrice: number;
        stopLoss: number;
        takeProfit: number;
        notional: number;
        correlationGroup: string;
        mode: string;
        requestedPrice: number;
        fee: number;
      }) => {
        state.orders.push({
          memoId: input.memoId,
          instrument: input.instrument,
          direction: input.direction,
          at: Date.now(),
        });
        const positionId = nextPositionId++;
        state.positions.push({
          id: positionId,
          instrument: input.instrument,
          direction: input.direction,
          quantity: input.quantity,
          entryPrice: input.fillPrice,
          stopLoss: input.stopLoss,
          takeProfit: input.takeProfit,
          closed: false,
        });
        const orderId = nextId++;
        return { orderId, positionId };
      },
      createExit: async (input: { positionId: number; realisedPnl: number }) => {
        const pos = state.positions.find((p) => p.id === input.positionId);
        if (pos) pos.closed = true;
        state.equity += input.realisedPnl;
        state.dayPnl += input.realisedPnl;
      },
      recentTrades: async () => [],
      lastTrade: async () => undefined,
    },
    bot: {
      status: async () => ({
        paused: state.paused,
        executionMode: 'paper' as const,
        approveThreshold: state.approveThreshold,
        signalTimeframe: state.signalTimeframe,
      }),
      executionMode: async () => 'paper' as const,
      approveThreshold: async () => state.approveThreshold,
      setApproveThreshold: async (threshold: number) => {
        state.approveThreshold = threshold;
      },
      syncApproveThreshold: async (threshold: number) => {
        state.approveThreshold = threshold;
      },
      signalTimeframe: async () => state.signalTimeframe as '4h',
      setSignalTimeframe: async (timeframe: string) => {
        state.signalTimeframe = timeframe;
      },
      syncSignalTimeframe: async (timeframe: string) => {
        state.signalTimeframe = timeframe;
      },
      setExecutionMode: async () => {},
      syncExecutionMode: async () => {},
      pause: async () => {
        state.paused = true;
      },
      resume: async () => {
        state.paused = false;
      },
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

export function makeFakePositionMonitor(): PositionMonitor {
  return { run: async () => ({ closed: 0, marked: 0, errors: [] }) } as unknown as PositionMonitor;
}

export function makeTestPipelineDeps(
  repositories: Repositories,
  marketData: unknown,
  news: unknown,
  config = loadConfig({ instruments: [{ symbol: 'BTCUSDT', label: 'Bitcoin', correlationGroup: 'crypto-major', quantityStep: 0.00001, priceDecimals: 2 }], data: { requestSpacingMs: 0 } }),
) {
  return {
    config,
    repositories,
    marketData,
    news,
    executor: new PaperExecutionProvider({ config, repositories }),
    positionMonitor: makeFakePositionMonitor(),
  };
}
