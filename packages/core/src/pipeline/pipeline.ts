import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import type { MarketDataProvider, NewsProvider } from '../providers/types.js';
import { SignalDetector } from '../stages/detectors/index.js';
import { TradePlanBuilder } from '../stages/planner.js';
import { RiskGate, summariseFailures } from '../stages/risk-gate/index.js';
import { MarketScanner } from '../stages/scanner.js';
import { DecisionScorer } from '../stages/scoring.js';
import type { DecisionMemo, MarketSnapshot, PipelineDrop, PipelineRunStats, PortfolioState } from '../types.js';

export interface PipelineDeps {
  config: EngineConfig;
  repositories: Repositories;
  marketData: MarketDataProvider;
  news: NewsProvider;
  logger?: Logger;
}

/**
 * Orchestrates stages 1 → 6 and stops at the review queue.
 *
 * The pipeline's terminal action is `review.enqueue`. Nothing downstream of it
 * exists: there is no execution stage, no order client and no code path from a
 * memo to a broker. A human reading the queue is the only way anything happens.
 */
export class Pipeline {
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly scanner: MarketScanner;
  private readonly detector: SignalDetector;
  private readonly planner: TradePlanBuilder;
  private readonly riskGate: RiskGate;
  private readonly scorer: DecisionScorer;

  constructor(private readonly deps: PipelineDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? silentLogger).child({ component: 'pipeline' });
    this.scanner = new MarketScanner({
      config: deps.config,
      marketData: deps.marketData,
      news: deps.news,
      newsCache: deps.repositories.newsCache,
      logger: deps.logger,
    });
    this.detector = new SignalDetector(deps.config);
    this.planner = new TradePlanBuilder(deps.config);
    this.riskGate = new RiskGate(deps.config);
    this.scorer = new DecisionScorer(deps.config);
  }

  async run(mode: 'live' | 'once' = 'live'): Promise<PipelineRunStats> {
    const startedAt = new Date();
    const repos = this.deps.repositories;
    const runId = await repos.runs.start(mode);
    const logger = this.logger.child({ runId });

    const stats: PipelineRunStats = {
      runId,
      startedAt: startedAt.toISOString(),
      finishedAt: startedAt.toISOString(),
      durationMs: 0,
      instrumentsScanned: 0,
      snapshotsStored: 0,
      signalsDetected: 0,
      plansBuilt: 0,
      riskGatePassed: 0,
      riskGateBlocked: 0,
      memosCreated: 0,
      approved: 0,
      watchlist: 0,
      rejected: 0,
      queuedForReview: 0,
      supersededDuplicates: 0,
      suppressedDuplicates: 0,
      drops: [],
      errors: [],
    };

    try {
      const expired = await repos.review.expireStale();
      if (expired > 0) logger.info('expired stale review items', { count: expired });

      // Read once per run so every instrument is gated against the same
      // portfolio state; re-reading mid-run could let two plans each pass a
      // limit that they jointly breach.
      const portfolio = await repos.portfolio.current(this.config.account.startingEquity);
      logger.info('portfolio state loaded', {
        equity: portfolio.equity,
        peakEquity: portfolio.peakEquity,
        openPositions: portfolio.openPositions.length,
        dayRealisedPnl: portfolio.dayRealisedPnl,
      });

      const { snapshots, failures } = await this.scanner.scanAll();
      stats.instrumentsScanned = snapshots.length;
      for (const failure of failures) {
        stats.errors.push(`${failure.instrument}: ${failure.error}`);
        stats.drops.push({ instrument: failure.instrument, stage: 'scanner', reason: failure.error });
      }

      for (const snapshot of snapshots) {
        try {
          await this.processSnapshot(snapshot, portfolio, runId, stats, logger);
        } catch (error) {
          const message = (error as Error).message;
          stats.errors.push(`${snapshot.instrument}: ${message}`);
          logger.error('instrument processing failed', { instrument: snapshot.instrument, error: message });
        }
      }
    } catch (error) {
      stats.errors.push((error as Error).message);
      this.logger.error('pipeline run failed', { error: (error as Error).message });
    }

    const finishedAt = new Date();
    stats.finishedAt = finishedAt.toISOString();
    stats.durationMs = finishedAt.getTime() - startedAt.getTime();
    await this.deps.repositories.runs.finish(runId, stats);

    logger.info('pipeline run complete', {
      durationMs: stats.durationMs,
      scanned: stats.instrumentsScanned,
      signals: stats.signalsDetected,
      plans: stats.plansBuilt,
      passed: stats.riskGatePassed,
      blocked: stats.riskGateBlocked,
      approved: stats.approved,
      watchlist: stats.watchlist,
      rejected: stats.rejected,
      queued: stats.queuedForReview,
      superseded: stats.supersededDuplicates,
      suppressed: stats.suppressedDuplicates,
      errors: stats.errors.length,
    });

    return stats;
  }

  /**
   * Stages 2 → 6 for one instrument. Every early return is recorded as a drop
   * with a reason, so "nothing happened" is always explainable.
   */
  private async processSnapshot(
    snapshot: MarketSnapshot,
    portfolio: PortfolioState,
    runId: number,
    stats: PipelineRunStats,
    logger: Logger,
  ): Promise<void> {
    const repos = this.deps.repositories;
    const instrument = this.findInstrument(snapshot.instrument);

    const snapshotId = await repos.snapshots.insert(snapshot, runId);
    stats.snapshotsStored += 1;
    const stored: MarketSnapshot = { ...snapshot, id: snapshotId };

    // Stage 2
    const candidate = this.detector.detect(stored);
    if (!candidate) {
      const results = this.detector.runDetectors(stored);
      const reason = `no detector produced an actionable signal: ${results
        .map((r) => `${r.name}=${r.triggered ? 'fired' : 'no'}`)
        .join(', ')}`;
      stats.drops.push({ instrument: snapshot.instrument, stage: 'detector', reason });
      logger.debug('no signal', { instrument: snapshot.instrument });
      return;
    }

    const signalId = await repos.signals.insert(candidate, snapshotId, runId);
    stats.signalsDetected += 1;
    const storedCandidate = { ...candidate, id: signalId, snapshotId };

    // Stage 3
    const planResult = this.planner.build(storedCandidate, stored, instrument);
    if (!planResult.ok) {
      stats.drops.push({ instrument: snapshot.instrument, stage: 'planner', reason: planResult.rejection.reason });
      logger.info('plan rejected at builder', {
        instrument: snapshot.instrument,
        reason: planResult.rejection.reason,
      });
      return;
    }

    const planId = await repos.plans.insert(planResult.plan, signalId, runId);
    stats.plansBuilt += 1;
    const plan = { ...planResult.plan, id: planId, signalId };

    // Stage 4 — audit rows are written whether or not the plan passes.
    const riskGate = this.riskGate.evaluate(plan, stored, instrument, portfolio);
    await repos.riskGate.insert(riskGate, planId, runId);

    if (riskGate.overallPass) stats.riskGatePassed += 1;
    else stats.riskGateBlocked += 1;

    // Stage 6 — a memo is written for blocked plans too, so the rejected list
    // stays available for backtesting the rubric.
    const memo = this.scorer.buildMemo({ candidate: storedCandidate, plan, riskGate, snapshot: stored });
    const memoId = await repos.memos.insert(memo, planId, runId);
    stats.memosCreated += 1;
    stats[memo.decision] += 1;

    if (!riskGate.overallPass) {
      stats.drops.push({
        instrument: snapshot.instrument,
        stage: 'risk-gate',
        reason: summariseFailures(riskGate),
      });
      logger.info('plan blocked by risk gate', {
        instrument: snapshot.instrument,
        memoId,
        reason: summariseFailures(riskGate),
      });
      return;
    }

    // Stage 5 — the only terminal action in the pipeline.
    if (memo.decision === 'rejected') {
      stats.drops.push({
        instrument: snapshot.instrument,
        stage: 'scoring',
        reason: `score ${memo.score.toFixed(2)} is below the ${this.config.scoring.thresholds.watchlist} watchlist cutoff`,
      });
      return;
    }

    const outcome = await repos.review.enqueue(memoId, this.config.review.pendingTtlMinutes, {
      supersedePendingDuplicates: this.config.review.supersedePendingDuplicates,
      duplicateCooldownMinutes: this.config.review.duplicateCooldownMinutes,
    });

    if (outcome === 'suppressed') {
      stats.suppressedDuplicates += 1;
      logger.info('memo suppressed; this idea was decided on recently', {
        instrument: snapshot.instrument,
        memoId,
        decision: memo.decision,
        score: memo.score,
      });
      return;
    }

    stats.queuedForReview += 1;
    if (outcome === 'superseded') stats.supersededDuplicates += 1;
    logger.info(
      outcome === 'superseded'
        ? 'memo queued for human review, replacing an older one for the same idea'
        : 'memo queued for human review',
      {
        instrument: snapshot.instrument,
        memoId,
        decision: memo.decision,
        score: memo.score,
      },
    );
  }

  private findInstrument(symbol: string): InstrumentConfig {
    const instrument = this.config.instruments.find((i) => i.symbol === symbol);
    if (!instrument) throw new Error(`${symbol} is not in the configured instrument list`);
    return instrument;
  }

  /**
   * Stages 2 → 6 without persistence, for tests and replay. Returns the memo
   * that would have been produced, or the reason it stopped short.
   */
  evaluateSnapshot(
    snapshot: MarketSnapshot,
    portfolio: PortfolioState,
  ): { memo: DecisionMemo } | { drop: PipelineDrop } {
    const instrument = this.findInstrument(snapshot.instrument);

    const candidate = this.detector.detect(snapshot);
    if (!candidate) {
      return { drop: { instrument: snapshot.instrument, stage: 'detector', reason: 'no actionable signal' } };
    }

    const planResult = this.planner.build(candidate, snapshot, instrument);
    if (!planResult.ok) {
      return { drop: { instrument: snapshot.instrument, stage: 'planner', reason: planResult.rejection.reason } };
    }

    const riskGate = this.riskGate.evaluate(planResult.plan, snapshot, instrument, portfolio);
    const memo = this.scorer.buildMemo({
      candidate,
      plan: planResult.plan,
      riskGate,
      snapshot,
    });
    return { memo };
  }
}
