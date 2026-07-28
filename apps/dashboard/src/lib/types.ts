/**
 * Shapes returned by @tse/api. Declared locally rather than imported from
 * @tse/core so the dashboard stays a plain client of the HTTP surface and does
 * not link against the engine's database code.
 */

export type Direction = 'long' | 'short';
export type Decision = 'approved' | 'watchlist' | 'rejected';
export type ReviewStatus =
  | 'pending'
  | 'acknowledged'
  | 'dismissed'
  | 'expired'
  | 'superseded'
  | 'suppressed';

export interface TradePlan {
  instrument: string;
  direction: Direction;
  entryZone: { low: number; high: number };
  stopLoss: number;
  targets: number[];
  riskRewardRatio: number;
  invalidation: string;
  timeframe: string;
  confidence: number;
  timestamp: string;
  referenceEntry: number;
  riskPerUnit: number;
  atrUsed: number;
}

export interface DetectorResult {
  name: string;
  triggered: boolean;
  strength: number;
  rationale: string;
  direction: Direction | null;
}

export interface RiskCheckResult {
  check: string;
  pass: boolean;
  detail: string;
  valueChecked: number;
  limit: number;
  margin: number;
  countsTowardMargin: boolean;
}

export interface RiskGateResult {
  overallPass: boolean;
  checks: RiskCheckResult[];
  sizing: { quantity: number; notional: number; riskAmount: number; riskPctOfEquity: number };
  aggregateMargin: number;
}

export interface ScoreComponent {
  component: string;
  weight: number;
  raw: number;
  contribution: number;
  basis: string;
}

export interface ReviewItem {
  memoId: number;
  status: ReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  notes?: string;
  createdAt: string;
  expiresAt: string;
}

export interface Memo {
  id: number;
  instrument: string;
  direction: Direction;
  score: number;
  decision: Decision;
  tradePlan: TradePlan;
  signalsFired: DetectorResult[];
  riskGateResult: RiskGateResult;
  scoreBreakdown: ScoreComponent[];
  rationale: string;
  timestamp: string;
  review?: ReviewItem;
}

export interface Stats {
  last24h: Record<Decision, number>;
  pendingReview: number;
  snapshotsStored: number;
  lastRun: {
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    instrumentsScanned: number;
    signalsDetected: number;
    plansBuilt: number;
    riskGatePassed: number;
    riskGateBlocked: number;
    queuedForReview: number;
    supersededDuplicates: number;
    suppressedDuplicates: number;
    errors: string[];
  } | null;
}

export interface Portfolio {
  equity: number;
  peakEquity: number;
  dayRealisedPnl: number;
  openPositions: { instrument: string; direction: Direction; notional: number }[];
  asOf: string;
}

export interface AuditEntry {
  memoId: number;
  action: string;
  actor: string;
  notes?: string;
  memoScore: number;
  createdAt: string;
}
