import { loadConfig } from '../src/config/index.js';
import { atr, macd, rsi, sma, toLogSeries, vwap } from '../src/indicators/index.js';
import type { EngineConfig, InstrumentConfig, Timeframe } from '../src/config/schema.js';
import type {
  Candle,
  KeyLevel,
  MarketSnapshot,
  MovingAverageSet,
  NewsContext,
  PortfolioState,
  TimeframeContext,
  TrendDirection,
  VolumeContext,
} from '../src/types.js';

/**
 * Synthetic market data builders. Every detector and gate test constructs its
 * input from these so a test states exactly the market condition it cares about
 * and nothing else.
 */

export const testConfig: EngineConfig = loadConfig();

export const testInstrument: InstrumentConfig = {
  symbol: 'BTCUSDT',
  label: 'Bitcoin',
  correlationGroup: 'crypto-major',
  quantityStep: 0.00001,
  priceDecimals: 2,
};

export interface SeriesOptions {
  count?: number;
  start?: number;
  /** Fractional change per candle. 0.002 is a steady 0.2% climb. */
  drift?: number;
  /** Fractional high/low wick size around the body. */
  wick?: number;
  volume?: number;
  /** Candle duration in ms. Defaults to 4h. */
  intervalMs?: number;
  /** openTime of the final candle; earlier candles are spaced back from it. */
  endTime?: number;
}

/** Deterministic candle series with a constant drift and no randomness. */
export function makeCandles(options: SeriesOptions = {}): Candle[] {
  const count = options.count ?? 300;
  const start = options.start ?? 100;
  const drift = options.drift ?? 0;
  const wick = options.wick ?? 0.002;
  const volume = options.volume ?? 1000;
  const intervalMs = options.intervalMs ?? 4 * 3_600_000;
  const endTime = options.endTime ?? Date.now() - intervalMs;

  const candles: Candle[] = [];
  let price = start;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);
    const openTime = endTime - (count - 1 - i) * intervalMs;
    candles.push({ openTime, closeTime: openTime + intervalMs - 1, open, high, low, close, volume });
    price = close;
  }
  return candles;
}

/** Overwrites the final candle, for building a specific last-bar condition. */
export function withLastCandle(candles: Candle[], patch: Partial<Candle>): Candle[] {
  const out = [...candles];
  const last = out[out.length - 1] as Candle;
  out[out.length - 1] = { ...last, ...patch };
  return out;
}

export function buildTimeframeContext(
  timeframe: Timeframe,
  candles: Candle[],
  overrides: Partial<TimeframeContext> = {},
  config: EngineConfig = testConfig,
): TimeframeContext {
  const closes = candles.map((c) => c.close);
  const movingAverages: MovingAverageSet = {};
  for (const period of [...config.scanner.maPeriods, config.detectors.trend.fastMaPeriod, config.detectors.trend.slowMaPeriod]) {
    movingAverages[period] = sma(closes, period);
  }

  const fast = movingAverages[config.detectors.trend.fastMaPeriod];
  const slow = movingAverages[config.detectors.trend.slowMaPeriod];
  const separation = fast !== undefined && slow !== undefined ? (fast - slow) / slow : 0;
  const trend: TrendDirection =
    Math.abs(separation) < config.detectors.trend.flatThresholdPct ? 'flat' : separation > 0 ? 'up' : 'down';

  const lookback = Math.min(config.detectors.breakout.lookback, candles.length);
  const window = candles.slice(candles.length - lookback);

  return {
    timeframe,
    candles,
    lastClose: closes[closes.length - 1] as number,
    atr: atr(candles, config.volatility.atrPeriod),
    movingAverages,
    trend,
    trendStrength: separation,
    rsi: rsi(closes, config.detectors.momentum.rsiPeriod),
    macd: macd(
      toLogSeries(closes),
      config.detectors.momentum.macdFast,
      config.detectors.momentum.macdSlow,
      config.detectors.momentum.macdSignal,
    ),
    vwap: vwap(candles, Math.min(config.scanner.volumeAveragePeriod, candles.length)),
    rangeHigh: Math.max(...window.map((c) => c.high)),
    rangeLow: Math.min(...window.map((c) => c.low)),
    ...overrides,
  };
}

export interface SnapshotOptions {
  instrument?: string;
  price?: number;
  /** Candles per timeframe. Missing timeframes are generated from `series`. */
  candles?: Partial<Record<Timeframe, Candle[]>>;
  series?: SeriesOptions;
  volume?: Partial<VolumeContext>;
  keyLevels?: KeyLevel[];
  news?: Partial<NewsContext>;
  higherTimeframeTrend?: TrendDirection;
  timeframeOverrides?: Partial<Record<Timeframe, Partial<TimeframeContext>>>;
  config?: EngineConfig;
}

export function makeSnapshot(options: SnapshotOptions = {}): MarketSnapshot {
  const config = options.config ?? testConfig;
  const timeframes: Partial<Record<Timeframe, TimeframeContext>> = {};

  for (const timeframe of config.scanner.timeframes) {
    const candles = options.candles?.[timeframe] ?? makeCandles(options.series);
    timeframes[timeframe] = buildTimeframeContext(
      timeframe,
      candles,
      options.timeframeOverrides?.[timeframe] ?? {},
      config,
    );
  }

  const reference = timeframes[config.volatility.atrTimeframe] as TimeframeContext;
  const price = options.price ?? reference.lastClose;

  const volume: VolumeContext = {
    current: 1000,
    rollingAverage: 1000,
    ratio: 1,
    isSpike: false,
    ...options.volume,
  };

  const news: NewsContext = {
    items: [],
    aggregateSentiment: 0,
    itemCount: 0,
    provider: 'test',
    ...options.news,
  };

  const keyLevels = options.keyLevels ?? [];
  const touching = (kind: KeyLevel['kind']) => keyLevels.some((l) => l.kind === kind && l.isTouching);

  return {
    instrument: options.instrument ?? testInstrument.symbol,
    label: testInstrument.label,
    correlationGroup: testInstrument.correlationGroup,
    capturedAt: new Date().toISOString(),
    price,
    volume,
    timeframes,
    higherTimeframeTrend:
      options.higherTimeframeTrend ?? timeframes[config.detectors.trend.higherTimeframe]?.trend ?? 'flat',
    keyLevels,
    setupCandidates: {
      touchingResistance: touching('resistance'),
      touchingSupport: touching('support'),
      touchingVwap: touching('vwap'),
      nearRecentHigh: touching('recent-high'),
      nearRecentLow: touching('recent-low'),
      volumeSpike: volume.isSpike,
      any:
        volume.isSpike ||
        keyLevels.some((l) => l.isTouching),
    },
    news: { ...news, itemCount: news.items.length > 0 ? news.items.length : news.itemCount },
    warnings: [],
  };
}

export function makeKeyLevel(overrides: Partial<KeyLevel> & Pick<KeyLevel, 'kind' | 'price'>): KeyLevel {
  return {
    timeframe: '4h',
    touches: 2,
    distanceAtr: 0.1,
    isTouching: true,
    ...overrides,
  };
}

export function makePortfolio(overrides: Partial<PortfolioState> = {}): PortfolioState {
  return {
    equity: 10_000,
    peakEquity: 10_000,
    dayRealisedPnl: 0,
    openPositions: [],
    asOf: new Date().toISOString(),
    ...overrides,
  };
}
