/**
 * @tse/core — the whole engine as a library.
 *
 * Stages 1 → 7 plus persistence, paper execution, and replay.
 */

export * from './types.js';
export * from './config/index.js';
export * from './indicators/index.js';
export * from './logging/logger.js';
export * from './providers/index.js';
export * from './execution/index.js';

export { MarketScanner, type ScannerDeps, type NewsCache } from './stages/scanner.js';
export {
  SignalDetector,
  allDetectors,
  breakoutDetector,
  pullbackDetector,
  momentumDetector,
  trendDetector,
  reversalDetector,
  notTriggered,
  type Detector,
} from './stages/detectors/index.js';
export { TradePlanBuilder, type PlanResult, type PlanRejection } from './stages/planner.js';
export {
  RiskGate,
  summariseFailures,
  positionSizeCheck,
  exposureChecks,
  drawdownCheck,
  volatilityCheck,
  maxLossChecks,
  type CheckContext,
} from './stages/risk-gate/index.js';
export { DecisionScorer } from './stages/scoring.js';

export { Pipeline, type PipelineDeps } from './pipeline/pipeline.js';
export { Scheduler, type SchedulerOptions } from './pipeline/scheduler.js';

export {
  Replayer,
  type ReplayOptions,
  type ReplayResult,
  type ReplaySummary,
  type BucketStats,
  type Outcome,
} from './backtest/replay.js';

export { getPool, closePool, pingDatabase, withTransaction, type DbPool, type DbClient } from './db/pool.js';
export { runMigrations } from './db/migrate.js';
export {
  createRepositories,
  PipelineRunRepository,
  SnapshotRepository,
  SignalRepository,
  TradePlanRepository,
  RiskGateRepository,
  MemoRepository,
  ReviewQueueRepository,
  PortfolioRepository,
  ExecutionRepository,
  BotRuntimeRepository,
  NewsCacheRepository,
  BacktestRepository,
  type Repositories,
  type MemoQuery,
} from './db/repositories.js';
