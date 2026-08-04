import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import { withSignalTimeframe } from '../config/runtime.js';
import type { Repositories } from '../db/repositories.js';
import { shouldSkipExecution } from '../execution/cooldown.js';
import type { PositionMonitor } from '../execution/monitor.js';
import type { ExecutionProvider } from '../execution/types.js';
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
  executor: ExecutionProvider;
  positionMonitor: PositionMonitor;
  logger?: Logger;
}

/**
 * Orchestrates stages 1 → 7: scan, detect, plan, risk-gate, score, then
 * automatically execute approved memos in paper mode.
 *
 * The pipeline's terminal action for approved memos is `executor.submitEntry`.
 * Watchlist memos are recorded for observation only; rejected memos are dropped.
 */
export class Pipeline {
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private scanner: MarketScanner;
  private detector: SignalDetector;
  private planner: TradePlanBuilder;
  private riskGate: RiskGate;
  private readonly scorer: DecisionScorer;

  constructor(private readonly deps: PipelineDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? silentLogger).child({ component: 'pipeline' });
    this.scanner = this.createScanner(deps.config);
    this.detector = new SignalDetector(deps.config);
    this.planner = new TradePlanBuilder(deps.config);
    this.riskGate = new RiskGate(deps.config);
    this.scorer = new DecisionScorer(deps.config);
  }

  private createScanner(config: EngineConfig): MarketScanner {
    return new MarketScanner({
      config,
      marketData: this.deps.marketData,
      news: this.deps.news,
      newsCache: this.deps.repositories.newsCache,
      logger: this.deps.logger,
    });
  }

  private applyRunConfig(config: EngineConfig): void {
    this.scanner = this.createScanner(config);
    this.detector = new SignalDetector(config);
    this.planner = new TradePlanBuilder(config);
    this.riskGate = new RiskGate(config);
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
      executed: 0,
      executionSkipped: 0,
      positionsClosed: 0,
      executionErrors: 0,
      drops: [],
      errors: [],
    };

    try {
      const monitorResult = await this.deps.positionMonitor.run();
      stats.positionsClosed = monitorResult.closed;
      for (const err of monitorResult.errors) stats.errors.push(err);

      const expired = await repos.review.expireStale();
      if (expired > 0) logger.info('expired stale watchlist items', { count: expired });

      const approveThreshold = await repos.bot.approveThreshold();
      this.scorer.setApproveThreshold(approveThreshold);

      const signalTimeframe = await repos.bot.signalTimeframe();
      this.applyRunConfig(withSignalTimeframe(this.config, signalTimeframe));
      logger.info('runtime settings loaded', { approveThreshold, signalTimeframe });

      let portfolio = await repos.portfolio.current(this.config.account.startingEquity);
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
          portfolio = await this.processSnapshot(snapshot, portfolio, runId, stats, logger);
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
      executed: stats.executed,
      skipped: stats.executionSkipped,
      closed: stats.positionsClosed,
      errors: stats.errors.length,
    });

    return stats;
  }

  /**
   * Stages 2 → 7 for one instrument. Returns updated portfolio when a trade opens.
   */
  private async processSnapshot(
    snapshot: MarketSnapshot,
    portfolio: PortfolioState,
    runId: number,
    stats: PipelineRunStats,
    logger: Logger,
  ): Promise<PortfolioState> {
    const repos = this.deps.repositories;
    const instrument = this.findInstrument(snapshot.instrument);

    const snapshotId = await repos.snapshots.insert(snapshot, runId);
    stats.snapshotsStored += 1;
    const stored: MarketSnapshot = { ...snapshot, id: snapshotId };

    const candidate = this.detector.detect(stored);
    if (!candidate) {
      const results = this.detector.runDetectors(stored);
      const reason = `no detector produced an actionable signal: ${results
        .map((r) => `${r.name}=${r.triggered ? 'fired' : 'no'}`)
        .join(', ')}`;
      stats.drops.push({ instrument: snapshot.instrument, stage: 'detector', reason });
      logger.debug('no signal', { instrument: snapshot.instrument });
      return portfolio;
    }

    const signalId = await repos.signals.insert(candidate, snapshotId, runId);
    stats.signalsDetected += 1;
    const storedCandidate = { ...candidate, id: signalId, snapshotId };

    const planResult = this.planner.build(storedCandidate, stored, instrument);
    if (!planResult.ok) {
      stats.drops.push({ instrument: snapshot.instrument, stage: 'planner', reason: planResult.rejection.reason });
      logger.info('plan rejected at builder', {
        instrument: snapshot.instrument,
        reason: planResult.rejection.reason,
      });
      return portfolio;
    }

    const planId = await repos.plans.insert(planResult.plan, signalId, runId);
    stats.plansBuilt += 1;
    const plan = { ...planResult.plan, id: planId, signalId };

    const riskGate = this.riskGate.evaluate(plan, stored, instrument, portfolio);
    await repos.riskGate.insert(riskGate, planId, runId);

    if (riskGate.overallPass) stats.riskGatePassed += 1;
    else stats.riskGateBlocked += 1;

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
      return portfolio;
    }

    if (memo.decision === 'rejected') {
      stats.drops.push({
        instrument: snapshot.instrument,
        stage: 'scoring',
        reason: `score ${memo.score.toFixed(2)} is below the ${this.config.scoring.thresholds.watchlist} watchlist cutoff`,
      });
      return portfolio;
    }

    if (memo.decision === 'watchlist') {
      logger.info('watchlist memo recorded; bot does not trade below approval threshold', {
        instrument: snapshot.instrument,
        memoId,
        score: memo.score,
      });
      return portfolio;
    }

    // Stage 7 — approved memos are executed automatically.
    return this.tryExecute(memo, memoId, plan, instrument, snapshot.price, portfolio, stats, logger);
  }

  private async tryExecute(
    memo: DecisionMemo,
    memoId: number,
    plan: DecisionMemo['tradePlan'],
    instrument: InstrumentConfig,
    lastPrice: number,
    portfolio: PortfolioState,
    stats: PipelineRunStats,
    logger: Logger,
  ): Promise<PortfolioState> {
    const repos = this.deps.repositories;
    if (memo.decision !== 'approved') {
      return portfolio;
    }

    const { autoDecisions } = this.config.execution;
    if (!autoDecisions.includes('approved')) {
      stats.executionSkipped += 1;
      return portfolio;
    }

    const paused = await repos.bot.status();
    if (paused.paused) {
      stats.executionSkipped += 1;
      await repos.execution.logEvent({ memoId, eventType: 'paused', detail: 'kill switch active' });
      logger.info('execution skipped; bot paused', { instrument: memo.instrument, memoId });
      return portfolio;
    }

    const cooldown = await shouldSkipExecution(repos, {
      instrument: memo.instrument,
      direction: memo.direction,
      duplicateCooldownMinutes: this.config.review.duplicateCooldownMinutes,
    });
    if (cooldown.skip) {
      stats.executionSkipped += 1;
      await repos.execution.logEvent({ memoId, eventType: 'skipped', detail: cooldown.reason });
      logger.info('execution skipped', { instrument: memo.instrument, memoId, reason: cooldown.reason });
      return portfolio;
    }

    const storedMemo = { ...memo, id: memoId };
    const result = await this.deps.executor.submitEntry({
      memo: storedMemo,
      memoId,
      plan,
      sizing: memo.riskGateResult.sizing,
      instrument,
      lastPrice,
    });

    if (!result.ok) {
      stats.executionSkipped += 1;
      if (result.reason !== `duplicate open position on ${memo.instrument}`) {
        await repos.execution.logEvent({ memoId, eventType: 'skipped', detail: result.reason });
      }
      logger.info('execution skipped', { instrument: memo.instrument, memoId, reason: result.reason });
      return portfolio;
    }

    stats.executed += 1;
    logger.info('paper trade opened', {
      instrument: memo.instrument,
      memoId,
      orderId: result.orderId,
      positionId: result.positionId,
      fillPrice: result.fillPrice,
      quantity: result.quantity,
    });

    return repos.portfolio.current(this.config.account.startingEquity);
  }

  private findInstrument(symbol: string): InstrumentConfig {
    const instrument = this.config.instruments.find((i) => i.symbol === symbol);
    if (!instrument) throw new Error(`${symbol} is not in the configured instrument list`);
    return instrument;
  }

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
