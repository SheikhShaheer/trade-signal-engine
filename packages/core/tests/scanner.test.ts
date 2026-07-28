import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { StubNewsProvider } from '../src/providers/news-stub.js';
import { aggregateSentiment, scoreSentiment } from '../src/providers/sentiment.js';
import type { MarketDataProvider, NewsProvider } from '../src/providers/types.js';
import { MarketScanner } from '../src/stages/scanner.js';
import type { Candle, NewsItem, Timeframe } from '../src/types.js';
import { makeCandles, testInstrument } from './fixtures.js';

/** Market data provider backed by generated candles, with no network access. */
class FakeMarketData implements MarketDataProvider {
  readonly name = 'fake';
  calls: { symbol: string; timeframe: Timeframe }[] = [];

  constructor(
    private readonly candles: Candle[] = makeCandles({ count: 300, start: 100, drift: 0.002, wick: 0.004 }),
    private readonly failOn?: string,
  ) {}

  async getCandles(symbol: string, timeframe: Timeframe): Promise<Candle[]> {
    if (this.failOn === symbol) throw new Error(`upstream unavailable for ${symbol}`);
    this.calls.push({ symbol, timeframe });
    return this.candles;
  }

  async getLastPrice(): Promise<number> {
    return (this.candles[this.candles.length - 1] as Candle).close;
  }

  async assertSymbolSupported(): Promise<void> {}
}

class ThrowingNews implements NewsProvider {
  readonly name = 'throwing';
  async getNews(): Promise<NewsItem[]> {
    throw new Error('news provider is down');
  }
}

const singleInstrumentConfig = loadConfig({
  instruments: [testInstrument],
  data: { requestSpacingMs: 0 },
});

describe('MarketScanner', () => {
  it('builds a snapshot with a context per configured timeframe', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);

    expect(snapshot.instrument).toBe('BTCUSDT');
    for (const timeframe of singleInstrumentConfig.scanner.timeframes) {
      expect(snapshot.timeframes[timeframe]).toBeDefined();
    }
    expect(snapshot.price).toBeGreaterThan(0);
    expect(Date.parse(snapshot.capturedAt)).not.toBeNaN();
  });

  it('computes moving averages, ATR and RSI on the reference timeframe', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    const context = snapshot.timeframes[singleInstrumentConfig.volatility.atrTimeframe];

    expect(context?.atr).toBeGreaterThan(0);
    expect(context?.rsi).toBeGreaterThan(0);
    expect(context?.movingAverages[20]).toBeGreaterThan(0);
    expect(context?.movingAverages[200]).toBeGreaterThan(0);
  });

  it('classifies a steady advance as an uptrend', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0.004 })),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.higherTimeframeTrend).toBe('up');
  });

  it('classifies a steady decline as a downtrend', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(makeCandles({ count: 300, start: 500, drift: -0.004 })),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.higherTimeframeTrend).toBe('down');
  });

  it('reports a flat market as flat rather than guessing a direction', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(makeCandles({ count: 300, drift: 0 })),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.higherTimeframeTrend).toBe('flat');
  });

  it('flags a volume spike against the rolling average', async () => {
    const candles = makeCandles({ count: 300, volume: 1000 });
    const spiked = [...candles];
    spiked[spiked.length - 1] = { ...(spiked[spiked.length - 1] as Candle), volume: 100_000 };

    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(spiked),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.volume.ratio).toBeGreaterThan(singleInstrumentConfig.scanner.volumeSpikeRatio);
    expect(snapshot.volume.isSpike).toBe(true);
    expect(snapshot.setupCandidates.volumeSpike).toBe(true);
  });

  it('derives key levels with ATR-relative distances', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(),
      news: new StubNewsProvider(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.keyLevels.length).toBeGreaterThan(0);
    for (const level of snapshot.keyLevels) {
      expect(level.price).toBeGreaterThan(0);
      expect(level.distanceAtr).toBeGreaterThanOrEqual(0);
    }
    // Nearest level first.
    const distances = snapshot.keyLevels.map((l) => l.distanceAtr);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it('degrades to an empty news context with a warning when the provider fails', async () => {
    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(),
      news: new ThrowingNews(),
    });

    const snapshot = await scanner.scanInstrument(testInstrument);
    expect(snapshot.news.itemCount).toBe(0);
    expect(snapshot.news.aggregateSentiment).toBe(0);
    expect(snapshot.warnings.some((w) => w.includes('news fetch failed'))).toBe(true);
  });

  it('records a failed instrument without aborting the whole scan', async () => {
    const config = loadConfig({
      instruments: [
        testInstrument,
        { symbol: 'ETHUSDT', label: 'Ethereum', correlationGroup: 'crypto-major', quantityStep: 0.0001, priceDecimals: 2 },
      ],
      data: { requestSpacingMs: 0 },
    });

    const scanner = new MarketScanner({
      config,
      marketData: new FakeMarketData(undefined, 'ETHUSDT'),
      news: new StubNewsProvider(),
    });

    const { snapshots, failures } = await scanner.scanAll();
    expect(snapshots.map((s) => s.instrument)).toEqual(['BTCUSDT']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.instrument).toBe('ETHUSDT');
  });

  it('uses cached news instead of refetching within the news interval', async () => {
    let fetches = 0;
    const news: NewsProvider = {
      name: 'counting',
      async getNews() {
        fetches += 1;
        return [];
      },
    };

    const store = new Map<string, unknown>();
    const cache = {
      async get(instrument: string) {
        return store.get(instrument);
      },
      async put(instrument: string, _provider: string, payload: unknown) {
        store.set(instrument, payload);
      },
    };

    const scanner = new MarketScanner({
      config: singleInstrumentConfig,
      marketData: new FakeMarketData(),
      news,
      newsCache: cache,
    });

    await scanner.scanInstrument(testInstrument);
    await scanner.scanInstrument(testInstrument);
    expect(fetches).toBe(1);
  });
});

describe('sentiment', () => {
  it('scores positive and negative headlines with the right sign', () => {
    expect(scoreSentiment('Bitcoin surges to a record high on institutional inflows')).toBeGreaterThan(0);
    expect(scoreSentiment('Exchange hacked as regulators launch an investigation')).toBeLessThan(0);
  });

  it('returns exactly 0 when no lexicon term appears', () => {
    expect(scoreSentiment('The conference is scheduled for Tuesday')).toBe(0);
  });

  it('inverts the reading when the term is negated', () => {
    expect(scoreSentiment('Company denies fraud')).toBeGreaterThan(scoreSentiment('Company fraud confirmed'));
  });

  it('weights recent headlines above older ones', () => {
    const now = Date.now();
    const recentPositive = aggregateSentiment(
      [
        { sentiment: 1, publishedAt: new Date(now - 3_600_000).toISOString() },
        { sentiment: -1, publishedAt: new Date(now - 23 * 3_600_000).toISOString() },
      ],
      24,
      now,
    );
    expect(recentPositive).toBeGreaterThan(0);
  });

  it('ignores headlines outside the age window', () => {
    const now = Date.now();
    expect(
      aggregateSentiment([{ sentiment: 1, publishedAt: new Date(now - 100 * 3_600_000).toISOString() }], 24, now),
    ).toBe(0);
  });
});

describe('StubNewsProvider', () => {
  it('is deterministic for the same instrument and hour', async () => {
    const fixedNow = () => Date.parse('2026-01-15T10:30:00Z');
    const provider = new StubNewsProvider(fixedNow);
    const first = await provider.getNews('BTCUSDT', 'Bitcoin', 24);
    const second = await provider.getNews('BTCUSDT', 'Bitcoin', 24);
    expect(first).toEqual(second);
  });

  it('returns items newest first', async () => {
    const provider = new StubNewsProvider(() => Date.parse('2026-01-15T10:30:00Z'));
    const items = await provider.getNews('ETHUSDT', 'Ethereum', 24);
    const times = items.map((i) => Date.parse(i.publishedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
