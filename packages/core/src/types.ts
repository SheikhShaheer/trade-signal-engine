import type { Timeframe } from './config/schema.js';

export type { Timeframe };

export type Direction = 'long' | 'short';
export type TrendDirection = 'up' | 'down' | 'flat';
export type Decision = 'approved' | 'watchlist' | 'rejected';
export type ReviewStatus =
  | 'pending'
  | 'acknowledged'
  | 'dismissed'
  | 'expired'
  /** Replaced in the queue by a fresher memo for the same instrument + direction. */
  | 'superseded'
  /** Kept out of the queue because a human decided on this same idea recently. */
  | 'suppressed';

/**
 * What happened when a memo reached the review queue. Every outcome persists the
 * memo; they differ only in whether a human is asked to look at it.
 */
export type EnqueueOutcome = 'queued' | 'superseded' | 'suppressed';

// ---------------------------------------------------------------------------
// Stage 1 — Market Scanner output
// ---------------------------------------------------------------------------

export interface Candle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MovingAverageSet {
  /** Keyed by period, e.g. { 20: 61234.5 }. Absent when history is too short. */
  [period: number]: number | undefined;
}

export interface TimeframeContext {
  timeframe: Timeframe;
  candles: Candle[];
  lastClose: number;
  atr: number | undefined;
  movingAverages: MovingAverageSet;
  trend: TrendDirection;
  /** Fractional distance between the fast and slow MA; sign follows the trend. */
  trendStrength: number;
  rsi: number | undefined;
  /**
   * Computed on log prices, so values are fractional rather than in price units
   * and mean the same thing in a rising and a falling market.
   */
  macd: { macd: number; signal: number; histogram: number } | undefined;
  vwap: number | undefined;
  rangeHigh: number;
  rangeLow: number;
}

export interface VolumeContext {
  current: number;
  rollingAverage: number;
  /** current / rollingAverage. 1 means average. */
  ratio: number;
  isSpike: boolean;
}

export type KeyLevelKind = 'support' | 'resistance' | 'vwap' | 'recent-high' | 'recent-low';

export interface KeyLevel {
  kind: KeyLevelKind;
  price: number;
  timeframe: Timeframe;
  /** Number of touches found in the lookback window. Higher is more meaningful. */
  touches: number;
  /** |price - level| expressed in ATR units on the reference timeframe. */
  distanceAtr: number;
  isTouching: boolean;
}

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  url: string | undefined;
  publishedAt: string;
  /** -1 (very negative) .. +1 (very positive). */
  sentiment: number;
}

export interface NewsContext {
  items: NewsItem[];
  /** Recency-weighted mean sentiment across items, -1 .. +1. */
  aggregateSentiment: number;
  /** Zero when no items are in the window; treated as "no information". */
  itemCount: number;
  provider: string;
}

export interface SetupCandidateFlags {
  touchingResistance: boolean;
  touchingSupport: boolean;
  touchingVwap: boolean;
  nearRecentHigh: boolean;
  nearRecentLow: boolean;
  volumeSpike: boolean;
  /** True when at least one flag above is set. */
  any: boolean;
}

export interface MarketSnapshot {
  /** Assigned by the store; undefined until persisted. */
  id?: number;
  instrument: string;
  label: string;
  correlationGroup: string;
  capturedAt: string;
  price: number;
  volume: VolumeContext;
  timeframes: Partial<Record<Timeframe, TimeframeContext>>;
  /** Trend on the configured higher timeframe, lifted for convenience. */
  higherTimeframeTrend: TrendDirection;
  keyLevels: KeyLevel[];
  setupCandidates: SetupCandidateFlags;
  news: NewsContext;
  /** Non-fatal problems encountered while building the snapshot. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Stage 2 — Signal Detector output
// ---------------------------------------------------------------------------

export type DetectorName = 'breakout' | 'pullback' | 'momentum' | 'trend' | 'reversal';

export interface DetectorResult {
  name: DetectorName;
  triggered: boolean;
  /** 0..1 conviction. Meaningless when triggered is false. */
  strength: number;
  rationale: string;
  /** Direction the detector argues for; undefined when it is direction-neutral. */
  direction: Direction | undefined;
  /** Numbers behind the verdict, kept for audit and backtesting. */
  evidence: Record<string, number | string | boolean>;
}

export interface SignalCandidate {
  id?: number;
  snapshotId?: number;
  instrument: string;
  capturedAt: string;
  detectors: DetectorResult[];
  triggeredDetectors: DetectorResult[];
  /** Net direction implied by triggered detectors. */
  direction: Direction;
  /** How many triggered detectors agree with `direction`. */
  agreementCount: number;
  /** How many triggered detectors argue the opposite way. */
  disagreementCount: number;
  /** True when the implied direction fights the higher-timeframe trend. */
  counterTrend: boolean;
}

// ---------------------------------------------------------------------------
// Stage 3 — Trade Plan Builder output
// ---------------------------------------------------------------------------

export interface TradePlan {
  id?: number;
  signalId?: number;
  instrument: string;
  direction: Direction;
  entryZone: { low: number; high: number };
  stopLoss: number;
  targets: number[];
  /** Computed from entry/stop/first-target, never asserted. */
  riskRewardRatio: number;
  /** Specific, checkable condition that kills the idea. */
  invalidation: string;
  timeframe: Timeframe;
  /** 0..1 pre-risk-gate confidence. */
  confidence: number;
  timestamp: string;
  /** Reference entry used for all derived maths (midpoint of the entry zone). */
  referenceEntry: number;
  /** Absolute price distance from reference entry to stop. */
  riskPerUnit: number;
  atrUsed: number;
}

// ---------------------------------------------------------------------------
// Stage 4 — Risk Gate output
// ---------------------------------------------------------------------------

export interface RiskCheckResult {
  check: string;
  pass: boolean;
  detail: string;
  valueChecked: number;
  limit: number;
  /**
   * 0..1 headroom against the limit: 1 means far inside, 0 means at or past it.
   * Feeds the risk-gate-margin scoring component.
   */
  margin: number;
  /**
   * False for checks whose margin is meaningless because the plan is
   * constructed to sit exactly at their limit — position sizing always consumes
   * the whole risk budget, so its headroom is always ~0 and would permanently
   * drag the risk-gate-margin score down. Such checks still pass or fail
   * normally; they just do not contribute to the aggregate margin.
   */
  countsTowardMargin: boolean;
}

export interface PositionSizing {
  /** Units of the instrument. */
  quantity: number;
  notional: number;
  /** Loss in account currency if the stop is hit. */
  riskAmount: number;
  riskPctOfEquity: number;
}

export interface RiskGateResult {
  overallPass: boolean;
  checks: RiskCheckResult[];
  sizing: PositionSizing;
  /** Mean margin across margin-relevant checks; 0 when any check failed. */
  aggregateMargin: number;
}

export interface OpenPosition {
  id?: number;
  instrument: string;
  correlationGroup: string;
  direction: Direction;
  quantity: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number;
  notional: number;
  openedAt: string;
  memoId?: number;
  orderId?: number;
  source?: 'bot' | 'manual';
  markPrice?: number;
  unrealisedPnl?: number;
}

export interface PortfolioState {
  equity: number;
  peakEquity: number;
  /** Realised P&L for the current UTC day; negative means a loss so far. */
  dayRealisedPnl: number;
  openPositions: OpenPosition[];
  asOf: string;
}

// ---------------------------------------------------------------------------
// Stage 6 — Decision Memo + Score
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  component: string;
  weight: number;
  /** 0..1 raw component score before weighting. */
  raw: number;
  /** raw * weight * 10, i.e. this component's contribution to the 0-10 score. */
  contribution: number;
  basis: string;
}

export interface DecisionMemo {
  id?: number;
  planId?: number;
  instrument: string;
  direction: Direction;
  /** 0..10 weighted score. */
  score: number;
  decision: Decision;
  tradePlan: TradePlan;
  signalsFired: DetectorResult[];
  riskGateResult: RiskGateResult;
  scoreBreakdown: ScoreComponent[];
  rationale: string;
  timestamp: string;
}

export interface ReviewItem {
  memoId: number;
  status: ReviewStatus;
  reviewedBy: string | undefined;
  reviewedAt: string | undefined;
  notes: string | undefined;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type PipelineStage =
  | 'scanner'
  | 'detector'
  | 'planner'
  | 'risk-gate'
  | 'scoring'
  | 'review-queue'
  | 'execution';

/** Why an instrument stopped short of producing a queued memo. */
export interface PipelineDrop {
  instrument: string;
  stage: PipelineStage;
  reason: string;
}

export interface PipelineRunStats {
  runId?: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  instrumentsScanned: number;
  snapshotsStored: number;
  signalsDetected: number;
  plansBuilt: number;
  riskGatePassed: number;
  riskGateBlocked: number;
  memosCreated: number;
  approved: number;
  watchlist: number;
  rejected: number;
  queuedForReview: number;
  /** Queued items that replaced an older pending memo for the same idea. */
  supersededDuplicates: number;
  /** Memos kept out of the queue because a human decided on the idea recently. */
  suppressedDuplicates: number;
  /** Paper/live entries filled this run. */
  executed: number;
  /** Approved memos that did not trade (paused, cooldown, duplicate position, etc.). */
  executionSkipped: number;
  /** Open positions closed by the monitor this run. */
  positionsClosed: number;
  executionErrors: number;
  drops: PipelineDrop[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type ExecutionMode = 'paper' | 'testnet' | 'live';
export type OrderStatus = 'pending' | 'filled' | 'rejected' | 'cancelled';
export type FillType = 'entry' | 'exit';
export type ExecutionEventType =
  | 'submitted'
  | 'filled'
  | 'rejected'
  | 'sl_hit'
  | 'tp_hit'
  | 'skipped'
  | 'paused'
  | 'closed';

export interface ExecutionOrder {
  id: number;
  memoId: number;
  mode: ExecutionMode;
  instrument: string;
  direction: Direction;
  quantity: number;
  requestedPrice: number;
  status: OrderStatus;
  createdAt: string;
}

export interface ExecutionFill {
  id: number;
  orderId: number;
  price: number;
  quantity: number;
  fee: number;
  fillType: FillType;
  filledAt: string;
}

export interface TradeRecord {
  order: ExecutionOrder;
  entryFill?: ExecutionFill;
  exitFill?: ExecutionFill;
  memoId: number;
  instrument: string;
  direction: Direction;
  realisedPnl?: number;
}

export interface RankedMemo extends DecisionMemo {
  id: number;
  review: ReviewItem | undefined;
}
