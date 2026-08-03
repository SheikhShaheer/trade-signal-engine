import { z } from 'zod';

/**
 * Every tunable number in the system is declared here. Stages read limits from
 * this object only; a magic number appearing inside a stage is a bug.
 */

export const timeframeSchema = z.enum(['15m', '1h', '4h', '1d']);
export type Timeframe = z.infer<typeof timeframeSchema>;

export const instrumentSchema = z.object({
  /** Exchange symbol, e.g. BTCUSDT. */
  symbol: z.string().min(3),
  /** Human label used in memos. */
  label: z.string().min(1),
  /**
   * Correlation group. Exposure caps apply per group, so instruments that tend
   * to move together should share one (e.g. all L1 majors).
   */
  correlationGroup: z.string().min(1),
  /** Minimum tradable quantity increment, used when rounding position size. */
  quantityStep: z.number().positive().default(0.0001),
  /** Price decimals used when rendering plan levels. */
  priceDecimals: z.number().int().min(0).max(8).default(2),
});
export type InstrumentConfig = z.infer<typeof instrumentSchema>;

export const accountConfigSchema = z.object({
  /**
   * Starting equity used when the portfolio table has no rows yet.
   * Floor is $10 so tiny accounts are first-class, not an afterthought.
   */
  startingEquity: z.number().min(10),
  currency: z.string().default('USD'),
  /** Fraction of equity that may be lost on a single trade at the stop. */
  riskPerTradePct: z.number().positive().max(0.1),
  /** Hard drawdown ceiling from peak equity. Breach blocks all new plans. */
  maxDrawdownPct: z.number().positive().max(1),
});

export const exposureConfigSchema = z.object({
  /** Max notional in one instrument as a fraction of equity. */
  maxPerInstrumentPct: z.number().positive(),
  /** Max notional across one correlation group as a fraction of equity. */
  maxPerGroupPct: z.number().positive(),
  /** Max total notional across the book as a fraction of equity. */
  maxPortfolioPct: z.number().positive(),
});

export const volatilityConfigSchema = z.object({
  atrPeriod: z.number().int().positive(),
  /** Timeframe the ATR used for sizing and volatility checks is measured on. */
  atrTimeframe: timeframeSchema,
  /** Lookback for the "normal" ATR baseline the current ATR is compared to. */
  normalisationLookback: z.number().int().positive(),
  /** Current ATR / baseline ATR above this blocks the plan. */
  maxAtrRatio: z.number().positive(),
  /** Below this the instrument is too quiet for the setup to be meaningful. */
  minAtrRatio: z.number().positive(),
});

export const maxLossConfigSchema = z.object({
  /**
   * Worst-case loss ceiling for one trade as a fraction of equity.
   * Equity-relative so a $10 account and a $10,000 account use the same rules.
   */
  perTradePctOfEquity: z.number().positive().max(1),
  /** Realised + proposed loss ceiling for one day as a fraction of equity. */
  perDayPctOfEquity: z.number().positive().max(1),
});

export const planningConfigSchema = z.object({
  /** Entry zone half-width as a multiple of ATR. */
  entryZoneAtrMultiple: z.number().positive(),
  /** Stop distance from entry as a multiple of ATR. */
  stopAtrMultiple: z.number().positive(),
  /** Reward multiples of risk for TP1/TP2/TP3. */
  targetRMultiples: z.array(z.number().positive()).min(1),
  /** Plans below this computed R:R never leave the builder. */
  minAcceptableRiskReward: z.number().positive(),
});

export const scoringWeightsSchema = z
  .object({
    signalStrength: z.number().min(0).max(1),
    trendAlignment: z.number().min(0).max(1),
    riskRewardQuality: z.number().min(0).max(1),
    riskGateMargin: z.number().min(0).max(1),
    newsConfirmation: z.number().min(0).max(1),
  })
  .refine(
    (w) => Math.abs(Object.values(w).reduce((a, b) => a + b, 0) - 1) < 1e-9,
    { message: 'scoring weights must sum to exactly 1' },
  );

export const scoringConfigSchema = z.object({
  weights: scoringWeightsSchema,
  /** R:R at or below this scores 0 on the risk/reward component. */
  riskRewardFloor: z.number().positive(),
  /** R:R at or above this scores 1 on the risk/reward component. */
  riskRewardCeiling: z.number().positive(),
  /**
   * Independent-agreement bonus: each additional triggered detector beyond the
   * first adds this much to the signal-strength component, capped at 1.
   */
  detectorAgreementBonus: z.number().min(0).max(1),
  thresholds: z.object({
    /** Score at or above this, with a passing risk gate, is approved. */
    approve: z.number().min(0).max(10),
    /** Score at or above this, with a passing risk gate, is watchlist. */
    watchlist: z.number().min(0).max(10),
  }),
});

export const detectorConfigSchema = z.object({
  breakout: z.object({
    enabled: z.boolean(),
    /** Candles used to define the range being broken. */
    lookback: z.number().int().positive(),
    /** Close must clear the range edge by this fraction of ATR. */
    minAtrClearance: z.number().positive(),
    /** Volume vs rolling average required to confirm the break. */
    minVolumeRatio: z.number().positive(),
  }),
  pullback: z.object({
    enabled: z.boolean(),
    /** Moving average the pullback is measured against. */
    maPeriod: z.number().int().positive(),
    /** Distance to the MA below this fraction of ATR counts as a touch. */
    maxAtrDistance: z.number().positive(),
  }),
  momentum: z.object({
    enabled: z.boolean(),
    rsiPeriod: z.number().int().positive(),
    /** RSI above this is bullish momentum. */
    rsiBullish: z.number().positive().max(100),
    /** RSI below this is bearish momentum. */
    rsiBearish: z.number().positive().max(100),
    macdFast: z.number().int().positive(),
    macdSlow: z.number().int().positive(),
    macdSignal: z.number().int().positive(),
    /**
     * How much near-term impulse may run against the MACD's own direction
     * before the move counts as fading, as a fraction of |MACD|. The histogram
     * measures acceleration, so a value opposing the trend this strongly means
     * the move is rolling over — the reversal detector's territory, not this
     * one's. 0 would reject every decelerating move, including healthy steady
     * trends, whose acceleration is ~0 by definition.
     */
    maxCounterImpulseRatio: z.number().positive(),
  }),
  trend: z.object({
    enabled: z.boolean(),
    /** Timeframe treated as the higher-timeframe trend reference. */
    higherTimeframe: timeframeSchema,
    fastMaPeriod: z.number().int().positive(),
    slowMaPeriod: z.number().int().positive(),
    /** MA separation below this fraction of price is treated as "flat". */
    flatThresholdPct: z.number().positive(),
  }),
  reversal: z.object({
    enabled: z.boolean(),
    rsiPeriod: z.number().int().positive(),
    /** RSI at or above this is exhaustion on the upside. */
    overbought: z.number().positive().max(100),
    /** RSI at or below this is exhaustion on the downside. */
    oversold: z.number().positive().max(100),
    /** Candles scanned for the key level being rejected. */
    levelLookback: z.number().int().positive(),
    /** Rejection wick must be at least this fraction of the candle range. */
    minWickRatio: z.number().min(0).max(1),
  }),
});

export const scannerConfigSchema = z.object({
  timeframes: z.array(timeframeSchema).min(1),
  /** Candles fetched per timeframe. Must exceed the longest MA period. */
  candleLimit: z.number().int().positive(),
  /** Lookback for the rolling volume average and spike detection. */
  volumeAveragePeriod: z.number().int().positive(),
  /** Moving averages computed for trend context on every timeframe. */
  maPeriods: z.array(z.number().int().positive()).min(1),
  /** Candles scanned for swing highs/lows that become key levels. */
  keyLevelLookback: z.number().int().positive(),
  /** Price within this fraction of ATR of a level counts as "touching" it. */
  levelProximityAtr: z.number().positive(),
  /** Volume ratio at or above this is recorded as a spike. */
  volumeSpikeRatio: z.number().positive(),
});

export const scheduleConfigSchema = z.object({
  /** Full pipeline cadence in seconds. */
  pipelineIntervalSec: z.number().int().positive(),
  /** News refresh cadence in seconds; snapshots reuse cached news between. */
  newsIntervalSec: z.number().int().positive(),
  /** Random delay added to each tick so instruments do not stampede the API. */
  jitterSec: z.number().int().min(0),
  /** Ticks are skipped rather than queued if the previous run still holds the lock. */
  maxRunDurationSec: z.number().int().positive(),
});

export const dataConfigSchema = z.object({
  /** Delay between per-instrument requests, to stay inside rate limits. */
  requestSpacingMs: z.number().int().min(0),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
  retryBackoffMs: z.number().int().min(0),
  /** News items older than this are ignored by the news component. */
  newsMaxAgeHours: z.number().positive(),
});

export const executionConfigSchema = z.object({
  /** paper = simulated; testnet = Binance Spot Testnet; live = future phase. */
  mode: z.enum(['paper', 'testnet', 'live']).default('paper'),
  /** Memo decisions the bot will act on automatically. */
  autoDecisions: z.array(z.enum(['approved', 'watchlist'])).min(1).default(['approved']),
  /** Simulated slippage applied against the fill price, in basis points. */
  slippageBps: z.number().min(0).max(1000).default(5),
  /** Simulated trading fee as a fraction of notional, in basis points. */
  feeBps: z.number().min(0).max(1000).default(10),
  /** Kill switch: halts new entries; position monitor still runs. */
  paused: z.boolean().default(false),
});
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export const reviewConfigSchema = z.object({
  /**
   * Pending items older than this are marked expired rather than silently
   * lingering, so a stale plan cannot be approved against a moved market.
   */
  pendingTtlMinutes: z.number().int().positive(),
  /** Rejected memos are retained for audit and backtesting, never deleted. */
  retainRejected: z.literal(true),
  /**
   * A still-valid setup is re-derived on every scan. When a fresher memo arrives
   * for an instrument + direction that is already awaiting review, the pending
   * item is superseded so the reviewer sees current levels instead of a growing
   * pile of near-identical memos.
   */
  supersedePendingDuplicates: z.boolean(),
  /**
   * How long a human decision stands. A new memo for the same instrument +
   * direction inside this window is recorded but kept out of the queue, so
   * dismissing an idea is not undone by the next scan.
   */
  duplicateCooldownMinutes: z.number().int().nonnegative(),
});

export const engineConfigSchema = z.object({
  instruments: z.array(instrumentSchema).min(1),
  account: accountConfigSchema,
  exposure: exposureConfigSchema,
  volatility: volatilityConfigSchema,
  maxLoss: maxLossConfigSchema,
  planning: planningConfigSchema,
  scoring: scoringConfigSchema,
  detectors: detectorConfigSchema,
  scanner: scannerConfigSchema,
  schedule: scheduleConfigSchema,
  data: dataConfigSchema,
  review: reviewConfigSchema,
  execution: executionConfigSchema,
});

export type EngineConfig = z.infer<typeof engineConfigSchema>;
export type AccountConfig = z.infer<typeof accountConfigSchema>;
export type ExposureConfig = z.infer<typeof exposureConfigSchema>;
export type VolatilityConfig = z.infer<typeof volatilityConfigSchema>;
export type MaxLossConfig = z.infer<typeof maxLossConfigSchema>;
export type PlanningConfig = z.infer<typeof planningConfigSchema>;
export type ScoringConfig = z.infer<typeof scoringConfigSchema>;
export type DetectorConfig = z.infer<typeof detectorConfigSchema>;
export type ScannerConfig = z.infer<typeof scannerConfigSchema>;
export type ScheduleConfig = z.infer<typeof scheduleConfigSchema>;
export type DataConfig = z.infer<typeof dataConfigSchema>;
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
