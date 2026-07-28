import type { EngineConfig, InstrumentConfig, Timeframe } from '../config/schema.js';
import {
  atr,
  clusterLevels,
  findSwingHighs,
  findSwingLows,
  macd,
  rsi,
  sma,
  toLogSeries,
  vwap,
} from '../indicators/index.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import { aggregateSentiment } from '../providers/sentiment.js';
import type { MarketDataProvider, NewsProvider } from '../providers/types.js';
import type {
  Candle,
  KeyLevel,
  MarketSnapshot,
  MovingAverageSet,
  NewsContext,
  SetupCandidateFlags,
  TimeframeContext,
  TrendDirection,
  VolumeContext,
} from '../types.js';

export interface NewsCache {
  get(instrument: string, maxAgeSeconds: number): Promise<unknown | undefined>;
  put(instrument: string, provider: string, payload: unknown): Promise<void>;
}

export interface ScannerDeps {
  config: EngineConfig;
  marketData: MarketDataProvider;
  news: NewsProvider;
  newsCache?: NewsCache;
  logger?: Logger;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stage 1. Pulls raw market state for each instrument and returns a
 * MarketSnapshot: prices, multi-timeframe candles and indicators, volume
 * context, trend context, key levels and news.
 *
 * A snapshot is a fact about the market, not a judgement about it. No scoring
 * or direction decisions happen here.
 */
export class MarketScanner {
  private readonly config: EngineConfig;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(private readonly deps: ScannerDeps) {
    this.config = deps.config;
    this.logger = (deps.logger ?? silentLogger).child({ stage: 'scanner' });
    this.now = deps.now ?? (() => Date.now());
  }

  /** Scans every configured instrument, spacing requests to respect rate limits. */
  async scanAll(): Promise<{ snapshots: MarketSnapshot[]; failures: { instrument: string; error: string }[] }> {
    const snapshots: MarketSnapshot[] = [];
    const failures: { instrument: string; error: string }[] = [];

    for (const instrument of this.config.instruments) {
      try {
        snapshots.push(await this.scanInstrument(instrument));
      } catch (error) {
        const message = (error as Error).message;
        failures.push({ instrument: instrument.symbol, error: message });
        this.logger.warn('instrument scan failed', { instrument: instrument.symbol, error: message });
      }
      if (this.config.data.requestSpacingMs > 0) await sleep(this.config.data.requestSpacingMs);
    }

    return { snapshots, failures };
  }

  async scanInstrument(instrument: InstrumentConfig): Promise<MarketSnapshot> {
    const warnings: string[] = [];
    const { scanner } = this.config;

    const candlesByTimeframe = new Map<Timeframe, Candle[]>();
    for (const timeframe of scanner.timeframes) {
      const candles = await this.deps.marketData.getCandles(instrument.symbol, timeframe, scanner.candleLimit);
      if (candles.length === 0) {
        throw new Error(`${instrument.symbol}: no ${timeframe} candles returned`);
      }
      candlesByTimeframe.set(timeframe, candles);
      if (this.config.data.requestSpacingMs > 0) await sleep(this.config.data.requestSpacingMs);
    }

    const price = await this.deps.marketData.getLastPrice(instrument.symbol);

    const timeframes: Partial<Record<Timeframe, TimeframeContext>> = {};
    for (const [timeframe, candles] of candlesByTimeframe) {
      const context = this.buildTimeframeContext(timeframe, candles, warnings, instrument.symbol);
      timeframes[timeframe] = context;
    }

    const referenceTimeframe = this.config.volatility.atrTimeframe;
    const reference = timeframes[referenceTimeframe];
    if (!reference) throw new Error(`${instrument.symbol}: missing reference timeframe ${referenceTimeframe}`);
    if (reference.atr === undefined) {
      warnings.push(`ATR unavailable on ${referenceTimeframe}; key-level distances fall back to a 1% band`);
    }
    const atrForLevels = reference.atr ?? price * 0.01;

    const volume = this.buildVolumeContext(candlesByTimeframe.get(referenceTimeframe) as Candle[]);
    const keyLevels = this.buildKeyLevels(instrument, price, atrForLevels, timeframes);
    const news = await this.fetchNews(instrument, warnings);

    const higherTimeframeTrend = timeframes[this.config.detectors.trend.higherTimeframe]?.trend ?? 'flat';
    const setupCandidates = this.buildSetupFlags(keyLevels, volume);

    return {
      instrument: instrument.symbol,
      label: instrument.label,
      correlationGroup: instrument.correlationGroup,
      capturedAt: new Date(this.now()).toISOString(),
      price,
      volume,
      timeframes,
      higherTimeframeTrend,
      keyLevels,
      setupCandidates,
      news,
      warnings,
    };
  }

  private buildTimeframeContext(
    timeframe: Timeframe,
    candles: Candle[],
    warnings: string[],
    symbol: string,
  ): TimeframeContext {
    const closes = candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1] as number;

    const movingAverages: MovingAverageSet = {};
    for (const period of this.config.scanner.maPeriods) {
      const value = sma(closes, period);
      movingAverages[period] = value;
      if (value === undefined) {
        warnings.push(`${symbol} ${timeframe}: only ${candles.length} candles, MA${period} unavailable`);
      }
    }
    // The trend detector may reference MAs that are not in scanner.maPeriods.
    for (const period of [this.config.detectors.trend.fastMaPeriod, this.config.detectors.trend.slowMaPeriod]) {
      if (movingAverages[period] === undefined) movingAverages[period] = sma(closes, period);
    }

    const { trend, strength } = this.classifyTrend(movingAverages, lastClose);
    const lookback = Math.min(this.config.detectors.breakout.lookback, candles.length);
    const window = candles.slice(candles.length - lookback);

    return {
      timeframe,
      candles,
      lastClose,
      atr: atr(candles, this.config.volatility.atrPeriod),
      movingAverages,
      trend,
      trendStrength: strength,
      rsi: rsi(closes, this.config.detectors.momentum.rsiPeriod),
      macd: macd(
        toLogSeries(closes),
        this.config.detectors.momentum.macdFast,
        this.config.detectors.momentum.macdSlow,
        this.config.detectors.momentum.macdSignal,
      ),
      vwap: vwap(candles, Math.min(this.config.scanner.volumeAveragePeriod, candles.length)),
      rangeHigh: Math.max(...window.map((c) => c.high)),
      rangeLow: Math.min(...window.map((c) => c.low)),
    };
  }

  /**
   * Trend from fast/slow MA separation. When the MAs are within
   * `flatThresholdPct` of each other there is no trend to align with, and
   * saying "up" would overstate what the data supports.
   */
  private classifyTrend(mas: MovingAverageSet, lastClose: number): { trend: TrendDirection; strength: number } {
    const { fastMaPeriod, slowMaPeriod, flatThresholdPct } = this.config.detectors.trend;
    const fast = mas[fastMaPeriod];
    const slow = mas[slowMaPeriod];

    if (fast === undefined || slow === undefined) {
      // Not enough history for the slow MA: fall back to price vs the longest
      // available MA rather than silently claiming "flat".
      const available = Object.entries(mas)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ({ period: Number(k), value: v as number }))
        .sort((a, b) => b.period - a.period)[0];
      if (!available) return { trend: 'flat', strength: 0 };
      const separation = (lastClose - available.value) / available.value;
      if (Math.abs(separation) < flatThresholdPct) return { trend: 'flat', strength: separation };
      return { trend: separation > 0 ? 'up' : 'down', strength: separation };
    }

    const separation = (fast - slow) / slow;
    if (Math.abs(separation) < flatThresholdPct) return { trend: 'flat', strength: separation };
    return { trend: separation > 0 ? 'up' : 'down', strength: separation };
  }

  private buildVolumeContext(candles: Candle[]): VolumeContext {
    const period = Math.min(this.config.scanner.volumeAveragePeriod, candles.length);
    const recent = candles.slice(candles.length - period);
    const current = (candles[candles.length - 1] as Candle).volume;
    const average = recent.reduce((acc, c) => acc + c.volume, 0) / recent.length;
    const ratio = average > 0 ? current / average : 0;
    return {
      current,
      rollingAverage: average,
      ratio,
      isSpike: ratio >= this.config.scanner.volumeSpikeRatio,
    };
  }

  /**
   * Support/resistance from clustered swing pivots, plus VWAP and the recent
   * range extremes. Distances are in ATR units so "close to the level" means
   * the same thing on BTC as on XRP.
   */
  private buildKeyLevels(
    instrument: InstrumentConfig,
    price: number,
    atrValue: number,
    timeframes: Partial<Record<Timeframe, TimeframeContext>>,
  ): KeyLevel[] {
    const { keyLevelLookback, levelProximityAtr } = this.config.scanner;
    const referenceTimeframe = this.config.volatility.atrTimeframe;
    const context = timeframes[referenceTimeframe];
    if (!context) return [];

    const window = context.candles.slice(Math.max(0, context.candles.length - keyLevelLookback));
    const tolerance = atrValue * 0.5;
    const levels: KeyLevel[] = [];

    const push = (kind: KeyLevel['kind'], levelPrice: number, touches: number) => {
      if (!Number.isFinite(levelPrice) || levelPrice <= 0) return;
      const distanceAtr = atrValue > 0 ? Math.abs(price - levelPrice) / atrValue : Number.POSITIVE_INFINITY;
      levels.push({
        kind,
        price: levelPrice,
        timeframe: referenceTimeframe,
        touches,
        distanceAtr,
        isTouching: distanceAtr <= levelProximityAtr,
      });
    };

    for (const level of clusterLevels(findSwingHighs(window), tolerance)) {
      push(level.price >= price ? 'resistance' : 'support', level.price, level.touches);
    }
    for (const level of clusterLevels(findSwingLows(window), tolerance)) {
      push(level.price <= price ? 'support' : 'resistance', level.price, level.touches);
    }
    if (context.vwap !== undefined) push('vwap', context.vwap, 1);
    push('recent-high', Math.max(...window.map((c) => c.high)), 1);
    push('recent-low', Math.min(...window.map((c) => c.low)), 1);

    // Nearest first: that is the order a human reads them in.
    return levels
      .sort((a, b) => a.distanceAtr - b.distanceAtr)
      .slice(0, 20)
      .map((level) => ({ ...level, price: Number(level.price.toFixed(instrument.priceDecimals)) }));
  }

  private buildSetupFlags(levels: KeyLevel[], volume: VolumeContext): SetupCandidateFlags {
    const touching = (kind: KeyLevel['kind']) => levels.some((l) => l.kind === kind && l.isTouching);
    const flags = {
      touchingResistance: touching('resistance'),
      touchingSupport: touching('support'),
      touchingVwap: touching('vwap'),
      nearRecentHigh: touching('recent-high'),
      nearRecentLow: touching('recent-low'),
      volumeSpike: volume.isSpike,
    };
    return { ...flags, any: Object.values(flags).some(Boolean) };
  }

  /**
   * News is cached because the pipeline ticks far more often than the news
   * cadence. A provider failure degrades to an empty context with a warning
   * rather than dropping the whole snapshot: technical state is still useful.
   */
  private async fetchNews(instrument: InstrumentConfig, warnings: string[]): Promise<NewsContext> {
    const provider = this.deps.news;
    const cache = this.deps.newsCache;
    const maxAgeHours = this.config.data.newsMaxAgeHours;

    if (cache) {
      const cached = (await cache.get(instrument.symbol, this.config.schedule.newsIntervalSec)) as
        | NewsContext
        | undefined;
      if (cached && Array.isArray(cached.items)) {
        return { ...cached, aggregateSentiment: aggregateSentiment(cached.items, maxAgeHours, this.now()) };
      }
    }

    try {
      const items = await provider.getNews(instrument.symbol, instrument.label, maxAgeHours);
      const context: NewsContext = {
        items,
        aggregateSentiment: aggregateSentiment(items, maxAgeHours, this.now()),
        itemCount: items.length,
        provider: provider.name,
      };
      if (cache) await cache.put(instrument.symbol, provider.name, context);
      return context;
    } catch (error) {
      warnings.push(`news fetch failed (${provider.name}): ${(error as Error).message}`);
      return { items: [], aggregateSentiment: 0, itemCount: 0, provider: provider.name };
    }
  }
}
