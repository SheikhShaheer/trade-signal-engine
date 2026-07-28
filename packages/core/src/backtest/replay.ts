import type { EngineConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { roundTo } from '../indicators/index.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import { SignalDetector } from '../stages/detectors/index.js';
import { TradePlanBuilder } from '../stages/planner.js';
import { RiskGate } from '../stages/risk-gate/index.js';
import { DecisionScorer } from '../stages/scoring.js';
import type { Candle, DecisionMemo, MarketSnapshot, PortfolioState } from '../types.js';

export type Outcome = 'target' | 'stop' | 'open' | 'no-data';

export interface ReplayResult {
  snapshotId: number;
  instrument: string;
  capturedAt: string;
  memo: DecisionMemo | undefined;
  dropReason: string | undefined;
  outcome: Outcome;
  /** Realised return in units of risk. +1.5 means TP1 was hit at 1.5R. */
  realisedR: number | undefined;
  /** How far into the future the outcome was resolved. */
  resolvedAfterMinutes: number | undefined;
}

export interface BucketStats {
  bucket: string;
  count: number;
  targetHits: number;
  stopHits: number;
  unresolved: number;
  hitRate: number | undefined;
  meanRealisedR: number | undefined;
  expectancyR: number | undefined;
}

export interface ReplaySummary {
  snapshotsReplayed: number;
  memosProduced: number;
  approved: number;
  watchlist: number;
  rejected: number;
  resolved: number;
  byScoreBucket: BucketStats[];
  byDecision: BucketStats[];
  /** Correlation between score and realised R across resolved items, -1..1. */
  scoreOutcomeCorrelation: number | undefined;
  warnings: string[];
}

export interface ReplayOptions {
  from: Date;
  to: Date;
  instruments?: string[];
  /** How far ahead to look for a target or stop hit. */
  forwardWindowHours?: number;
  /** Portfolio state used for the risk gate; defaults to the configured account. */
  portfolio?: PortfolioState;
  persist?: boolean;
  label?: string;
  logger?: Logger;
}

/**
 * Replays stages 2-6 over stored snapshots, then checks each plan against what
 * the market actually did next.
 *
 * The purpose is to sanity-check the scoring rubric before trusting it: if
 * high-scoring memos do not resolve better than low-scoring ones, the weights
 * are wrong. It is not a P&L simulator — there are no fees, no slippage and no
 * assumption that a human would have taken every trade.
 */
export class Replayer {
  private readonly detector: SignalDetector;
  private readonly planner: TradePlanBuilder;
  private readonly riskGate: RiskGate;
  private readonly scorer: DecisionScorer;

  constructor(
    private readonly config: EngineConfig,
    private readonly repositories: Repositories,
  ) {
    this.detector = new SignalDetector(config);
    this.planner = new TradePlanBuilder(config);
    this.riskGate = new RiskGate(config);
    this.scorer = new DecisionScorer(config);
  }

  async run(options: ReplayOptions): Promise<{ summary: ReplaySummary; results: ReplayResult[] }> {
    const logger = (options.logger ?? silentLogger).child({ component: 'replay' });
    const forwardWindowHours = options.forwardWindowHours ?? 72;
    const warnings: string[] = [];

    const snapshots = await this.repositories.snapshots.range(options.from, options.to, options.instruments);
    logger.info('loaded snapshots', { count: snapshots.length });
    if (snapshots.length === 0) {
      warnings.push('no snapshots in the requested window; run the pipeline first to accumulate history');
    }

    const portfolio: PortfolioState =
      options.portfolio ?? {
        equity: this.config.account.startingEquity,
        peakEquity: this.config.account.startingEquity,
        dayRealisedPnl: 0,
        openPositions: [],
        asOf: options.from.toISOString(),
      };

    // Future candles come from the snapshot that has the most history for each
    // instrument, which is the latest one.
    const futureCandles = this.buildFutureCandleIndex(snapshots);

    const results: ReplayResult[] = [];
    for (const snapshot of snapshots) {
      const result = this.replayOne(snapshot, portfolio, futureCandles, forwardWindowHours);
      results.push(result);
    }

    const summary = this.summarise(results, warnings);

    if (options.persist) {
      const backtestId = await this.repositories.backtests.createRun(
        options.label ?? `replay-${new Date().toISOString()}`,
        this.config,
        options.from,
        options.to,
      );
      for (const result of results) {
        await this.repositories.backtests.addResult(backtestId, {
          snapshotId: result.snapshotId,
          instrument: result.instrument,
          capturedAt: result.capturedAt,
          direction: result.memo?.direction,
          score: result.memo?.score,
          decision: result.memo?.decision,
          outcome: result.outcome,
          realisedR: result.realisedR,
          payload: { memo: result.memo, dropReason: result.dropReason, resolvedAfterMinutes: result.resolvedAfterMinutes },
        });
      }
      await this.repositories.backtests.finishRun(backtestId, summary);
      logger.info('replay persisted', { backtestId });
    }

    return { summary, results };
  }

  private replayOne(
    snapshot: MarketSnapshot,
    portfolio: PortfolioState,
    futureCandles: Map<string, Candle[]>,
    forwardWindowHours: number,
  ): ReplayResult {
    const base: ReplayResult = {
      snapshotId: snapshot.id as number,
      instrument: snapshot.instrument,
      capturedAt: snapshot.capturedAt,
      memo: undefined,
      dropReason: undefined,
      outcome: 'no-data',
      realisedR: undefined,
      resolvedAfterMinutes: undefined,
    };

    const instrument = this.config.instruments.find((i) => i.symbol === snapshot.instrument);
    if (!instrument) return { ...base, dropReason: 'instrument not in current config' };

    const candidate = this.detector.detect(snapshot);
    if (!candidate) return { ...base, dropReason: 'no actionable signal' };

    const planResult = this.planner.build(candidate, snapshot, instrument);
    if (!planResult.ok) return { ...base, dropReason: planResult.rejection.reason };

    const riskGate = this.riskGate.evaluate(planResult.plan, snapshot, instrument, portfolio);
    const memo = this.scorer.buildMemo({ candidate, plan: planResult.plan, riskGate, snapshot });

    const outcome = this.resolveOutcome(memo, futureCandles.get(snapshot.instrument) ?? [], forwardWindowHours);
    return { ...base, memo, ...outcome };
  }

  /**
   * Walks forward candle by candle to see whether the stop or the first target
   * came first.
   *
   * When a single candle spans both levels, the stop is assumed to have hit
   * first. Intrabar sequence is unknowable from OHLC, and the pessimistic
   * assumption is the only one that cannot flatter the rubric.
   */
  private resolveOutcome(
    memo: DecisionMemo,
    candles: readonly Candle[],
    forwardWindowHours: number,
  ): { outcome: Outcome; realisedR: number | undefined; resolvedAfterMinutes: number | undefined } {
    const plan = memo.tradePlan;
    const startMs = Date.parse(memo.timestamp);
    const cutoffMs = startMs + forwardWindowHours * 3_600_000;
    const forward = candles.filter((c) => c.openTime > startMs && c.openTime <= cutoffMs);

    if (forward.length === 0) {
      return { outcome: 'no-data', realisedR: undefined, resolvedAfterMinutes: undefined };
    }

    const target = plan.targets[0] as number;
    const stop = plan.stopLoss;
    const entry = plan.referenceEntry;
    const risk = Math.abs(entry - stop);

    for (const candle of forward) {
      const hitStop = plan.direction === 'long' ? candle.low <= stop : candle.high >= stop;
      const hitTarget = plan.direction === 'long' ? candle.high >= target : candle.low <= target;

      if (hitStop) {
        return {
          outcome: 'stop',
          realisedR: -1,
          resolvedAfterMinutes: Math.round((candle.closeTime - startMs) / 60_000),
        };
      }
      if (hitTarget) {
        const reward = Math.abs(target - entry);
        return {
          outcome: 'target',
          realisedR: risk > 0 ? roundTo(reward / risk, 3) : undefined,
          resolvedAfterMinutes: Math.round((candle.closeTime - startMs) / 60_000),
        };
      }
    }

    const last = forward[forward.length - 1] as Candle;
    const unrealised =
      risk > 0 ? (plan.direction === 'long' ? last.close - entry : entry - last.close) / risk : undefined;
    return {
      outcome: 'open',
      realisedR: unrealised === undefined ? undefined : roundTo(unrealised, 3),
      resolvedAfterMinutes: undefined,
    };
  }

  /**
   * Candles for outcome resolution, taken from the newest snapshot per
   * instrument since that one carries the most recent history.
   */
  private buildFutureCandleIndex(snapshots: readonly MarketSnapshot[]): Map<string, Candle[]> {
    const timeframe = this.config.volatility.atrTimeframe;
    const index = new Map<string, Candle[]>();

    for (const snapshot of snapshots) {
      const candles = snapshot.timeframes[timeframe]?.candles;
      if (!candles || candles.length === 0) continue;
      const existing = index.get(snapshot.instrument);
      const lastExisting = existing?.[existing.length - 1];
      const lastNew = candles[candles.length - 1] as Candle;
      if (!lastExisting || lastNew.closeTime > lastExisting.closeTime) {
        index.set(snapshot.instrument, [...candles]);
      }
    }
    return index;
  }

  private summarise(results: readonly ReplayResult[], warnings: string[]): ReplaySummary {
    const withMemo = results.filter((r) => r.memo !== undefined);
    const resolved = withMemo.filter((r) => r.outcome === 'target' || r.outcome === 'stop');

    if (withMemo.length > 0 && resolved.length === 0) {
      warnings.push(
        'no memo resolved to a target or stop inside the forward window; the history is too short to judge the rubric',
      );
    }

    const bucketise = (memo: DecisionMemo): string => {
      const score = memo.score;
      if (score >= 8) return '8.0-10';
      if (score >= 7.5) return '7.5-7.99';
      if (score >= 6.5) return '6.5-7.49';
      if (score >= 5) return '5.0-6.49';
      return '<5.0';
    };

    const group = (keyOf: (r: ReplayResult) => string): BucketStats[] => {
      const map = new Map<string, ReplayResult[]>();
      for (const result of withMemo) {
        const key = keyOf(result);
        const list = map.get(key);
        if (list) list.push(result);
        else map.set(key, [result]);
      }
      return [...map.entries()]
        .map(([bucket, items]) => {
          const targets = items.filter((i) => i.outcome === 'target').length;
          const stops = items.filter((i) => i.outcome === 'stop').length;
          const decided = targets + stops;
          const rValues = items
            .filter((i) => i.outcome === 'target' || i.outcome === 'stop')
            .map((i) => i.realisedR)
            .filter((r): r is number => r !== undefined);
          const meanR =
            rValues.length > 0 ? roundTo(rValues.reduce((a, b) => a + b, 0) / rValues.length, 3) : undefined;
          return {
            bucket,
            count: items.length,
            targetHits: targets,
            stopHits: stops,
            unresolved: items.length - decided,
            hitRate: decided > 0 ? roundTo(targets / decided, 3) : undefined,
            meanRealisedR: meanR,
            expectancyR: meanR,
          };
        })
        .sort((a, b) => b.bucket.localeCompare(a.bucket));
    };

    return {
      snapshotsReplayed: results.length,
      memosProduced: withMemo.length,
      approved: withMemo.filter((r) => r.memo?.decision === 'approved').length,
      watchlist: withMemo.filter((r) => r.memo?.decision === 'watchlist').length,
      rejected: withMemo.filter((r) => r.memo?.decision === 'rejected').length,
      resolved: resolved.length,
      byScoreBucket: group((r) => bucketise(r.memo as DecisionMemo)),
      byDecision: group((r) => (r.memo as DecisionMemo).decision),
      scoreOutcomeCorrelation: correlation(
        resolved.map((r) => (r.memo as DecisionMemo).score),
        resolved.map((r) => r.realisedR as number),
      ),
      warnings,
    };
  }
}

/** Pearson correlation; undefined when there is not enough variance to compute one. */
function correlation(xs: readonly number[], ys: readonly number[]): number | undefined {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return undefined;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    const dy = (ys[i] as number) - meanY;
    numerator += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return undefined;
  return roundTo(numerator / Math.sqrt(varX * varY), 3);
}
