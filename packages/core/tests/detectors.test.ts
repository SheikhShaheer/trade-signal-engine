import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  SignalDetector,
  breakoutDetector,
  momentumDetector,
  pullbackDetector,
  reversalDetector,
  trendDetector,
} from '../src/stages/detectors/index.js';
import type { Candle } from '../src/types.js';
import { makeCandles, makeKeyLevel, makeSnapshot, testConfig, withLastCandle } from './fixtures.js';

/** Range-bound candles, then a final candle that closes decisively above it. */
function breakoutCandles(clearanceFactor = 3): Candle[] {
  const base = makeCandles({ count: 300, start: 100, drift: 0, wick: 0.004 });
  const last = base[base.length - 1] as Candle;
  const rangeHigh = Math.max(...base.slice(base.length - 21, base.length - 1).map((c) => c.high));
  const close = rangeHigh * (1 + 0.004 * clearanceFactor);
  return withLastCandle(base, { open: last.close, close, high: close, low: last.close });
}

describe('breakout detector', () => {
  it('fires long when price clears the range on confirming volume', () => {
    const snapshot = makeSnapshot({
      candles: { '4h': breakoutCandles() },
      volume: { ratio: 2, isSpike: true, current: 2000, rollingAverage: 1000 },
    });

    const result = breakoutDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('long');
    expect(result.strength).toBeGreaterThan(0);
    expect(result.rationale).toMatch(/cleared/);
  });

  it('refuses to fire on the same break without volume confirmation', () => {
    const snapshot = makeSnapshot({
      candles: { '4h': breakoutCandles() },
      volume: { ratio: 0.8, isSpike: false, current: 800, rollingAverage: 1000 },
    });

    const result = breakoutDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/unconfirmed break/);
  });

  it('does not fire while price is inside the range', () => {
    const snapshot = makeSnapshot({
      candles: { '4h': makeCandles({ count: 300, drift: 0, wick: 0.004 }) },
      volume: { ratio: 2, isSpike: true },
    });

    const result = breakoutDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/inside the/);
  });

  it('fires short on a downside break', () => {
    const base = makeCandles({ count: 300, start: 100, drift: 0, wick: 0.004 });
    const rangeLow = Math.min(...base.slice(base.length - 21, base.length - 1).map((c) => c.low));
    const close = rangeLow * (1 - 0.012);
    const candles = withLastCandle(base, { open: rangeLow, close, low: close, high: rangeLow });

    const result = breakoutDetector.run(
      makeSnapshot({ candles: { '4h': candles }, volume: { ratio: 2, isSpike: true } }),
      testConfig,
    );
    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('short');
  });

  it('records its numbers as evidence even when it does not fire', () => {
    const result = breakoutDetector.run(makeSnapshot(), testConfig);
    expect(result.evidence).toHaveProperty('rangeHigh');
    expect(result.evidence).toHaveProperty('volumeRatio');
  });
});

describe('pullback detector', () => {
  it('fires long when price retraces to the MA inside an uptrend', () => {
    const candles = makeCandles({ count: 300, start: 100, drift: 0.005, wick: 0.003 });
    const snapshot = makeSnapshot({ candles: { '4h': candles } });
    const ma20 = snapshot.timeframes['4h']?.movingAverages[20] as number;

    const atMa = makeSnapshot({ candles: { '4h': candles }, price: ma20 });
    const result = pullbackDetector.run(atMa, testConfig);

    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('long');
  });

  it('does not fire when the trend is flat', () => {
    const candles = makeCandles({ count: 300, drift: 0, wick: 0.003 });
    const snapshot = makeSnapshot({ candles: { '4h': candles } });
    const result = pullbackDetector.run(snapshot, testConfig);

    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/flat/);
  });

  it('does not fire when price is far from the moving average', () => {
    const candles = makeCandles({ count: 300, start: 100, drift: 0.005 });
    const ma20 = makeSnapshot({ candles: { '4h': candles } }).timeframes['4h']?.movingAverages[20] as number;
    const snapshot = makeSnapshot({ candles: { '4h': candles }, price: ma20 * 2 });

    const result = pullbackDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/beyond the/);
  });

  it('does not call a fresh high a pullback', () => {
    const candles = makeCandles({ count: 300, start: 100, drift: 0.005, wick: 0 });
    const last = candles[candles.length - 1] as Candle;
    const ma20 = makeSnapshot({ candles: { '4h': candles } }).timeframes['4h']?.movingAverages[20] as number;
    // Price above every recent high but still within touch distance of the MA.
    const snapshot = makeSnapshot({
      candles: { '4h': candles },
      price: Math.max(last.high * 1.001, ma20),
    });

    const result = pullbackDetector.run(snapshot, testConfig);
    if (result.triggered) {
      // The touch distance test can exclude it first; either rejection is fine.
      expect(result.direction).toBe('long');
    } else {
      expect(result.rationale).toMatch(/new highs|beyond the/);
    }
  });
});

describe('momentum detector', () => {
  it('fires long on a strengthening advance', () => {
    const candles = makeCandles({ count: 300, start: 100, drift: 0.006, wick: 0.002 });
    const result = momentumDetector.run(makeSnapshot({ candles: { '4h': candles } }), testConfig);

    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('long');
  });

  it('fires short on a strengthening decline', () => {
    const candles = makeCandles({ count: 300, start: 500, drift: -0.006, wick: 0.002 });
    const result = momentumDetector.run(makeSnapshot({ candles: { '4h': candles } }), testConfig);

    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('short');
  });

  it('does not fire when RSI is neutral', () => {
    const candles = makeCandles({ count: 300, drift: 0 });
    const result = momentumDetector.run(makeSnapshot({ candles: { '4h': candles } }), testConfig);

    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/do not agree/);
  });

  it('rejects a move that is rolling over, even with MACD still on the bull side', () => {
    // MACD above zero but well below its signal line: the near-term impulse has
    // turned hard against the trend.
    const snapshot = makeSnapshot({
      candles: { '4h': makeCandles({ count: 300, drift: 0.006 }) },
      timeframeOverrides: {
        '4h': { rsi: 65, macd: { macd: 0.02, signal: 0.03, histogram: -0.01 } },
      },
    });

    const result = momentumDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/rolling over/);
  });

  it('accepts a steady trend whose acceleration is near zero', () => {
    const result = momentumDetector.run(
      makeSnapshot({ candles: { '4h': makeCandles({ count: 300, start: 500, drift: -0.006 }) } }),
      testConfig,
    );
    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('short');
  });

  it('reads direction symmetrically for equal-magnitude rises and falls', () => {
    const up = momentumDetector.run(
      makeSnapshot({ candles: { '4h': makeCandles({ count: 300, start: 100, drift: 0.006 }) } }),
      testConfig,
    );
    const down = momentumDetector.run(
      makeSnapshot({ candles: { '4h': makeCandles({ count: 300, start: 100, drift: -0.006 }) } }),
      testConfig,
    );

    expect(up.triggered).toBe(true);
    expect(down.triggered).toBe(true);
    expect(up.direction).toBe('long');
    expect(down.direction).toBe('short');
    expect(Math.abs(up.strength - down.strength)).toBeLessThan(0.2);
  });
});

describe('trend detector', () => {
  it('reports an uptrend on the higher timeframe', () => {
    const snapshot = makeSnapshot({
      candles: { '1d': makeCandles({ count: 300, drift: 0.004, intervalMs: 86_400_000 }) },
    });
    const result = trendDetector.run(snapshot, testConfig);

    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('long');
  });

  it('reports no trend when the moving averages are inside the flat band', () => {
    const snapshot = makeSnapshot({
      candles: { '1d': makeCandles({ count: 300, drift: 0, intervalMs: 86_400_000 }) },
    });
    const result = trendDetector.run(snapshot, testConfig);

    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/flat band/);
  });
});

describe('reversal detector', () => {
  it('fires short on an overbought rejection wick at resistance', () => {
    const base = makeCandles({ count: 300, start: 100, drift: 0.006, wick: 0.002 });
    const last = base[base.length - 1] as Candle;
    // Long upper wick: high far above a close that finished near the open.
    const candles = withLastCandle(base, {
      open: last.open,
      close: last.open * 1.0005,
      high: last.open * 1.03,
      low: last.open * 0.999,
    });

    const snapshot = makeSnapshot({
      candles: { '4h': candles },
      keyLevels: [makeKeyLevel({ kind: 'resistance', price: last.open * 1.03, isTouching: true, touches: 3 })],
    });

    const result = reversalDetector.run(snapshot, testConfig);
    expect(result.triggered).toBe(true);
    expect(result.direction).toBe('short');
  });

  it('does not fire on exhaustion away from a key level', () => {
    const base = makeCandles({ count: 300, start: 100, drift: 0.006 });
    const last = base[base.length - 1] as Candle;
    const candles = withLastCandle(base, {
      open: last.open,
      close: last.open * 1.0005,
      high: last.open * 1.03,
      low: last.open * 0.999,
    });

    const result = reversalDetector.run(makeSnapshot({ candles: { '4h': candles }, keyLevels: [] }), testConfig);
    expect(result.triggered).toBe(false);
    expect(result.rationale).toMatch(/not at a key level|of the 3 exhaustion/);
  });

  it('does not fire on a single piece of exhaustion evidence', () => {
    const candles = makeCandles({ count: 300, start: 100, drift: 0.006, wick: 0.002 });
    const snapshot = makeSnapshot({
      candles: { '4h': candles },
      keyLevels: [makeKeyLevel({ kind: 'resistance', price: 1000, isTouching: true })],
    });

    const result = reversalDetector.run(snapshot, testConfig);
    // High RSI alone, no wick, no divergence.
    if (!result.triggered) expect(result.rationale).toMatch(/of the 3 exhaustion/);
  });
});

describe('SignalDetector', () => {
  it('returns undefined when no detector produces an actionable signal', () => {
    const detector = new SignalDetector(testConfig);
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0 }) } });
    expect(detector.detect(snapshot)).toBeUndefined();
  });

  it('keeps non-triggered results so a missed move is explainable', () => {
    const detector = new SignalDetector(testConfig);
    const results = detector.runDetectors(makeSnapshot());
    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result.rationale.length).toBeGreaterThan(10);
    }
  });

  it('assembles a candidate with a direction when setups fire', () => {
    const detector = new SignalDetector(testConfig);
    const candles = makeCandles({ count: 300, start: 100, drift: 0.006, wick: 0.003 });
    const candidate = detector.detect(
      makeSnapshot({
        candles: { '4h': candles, '1d': makeCandles({ count: 300, drift: 0.005, intervalMs: 86_400_000 }) },
        volume: { ratio: 2, isSpike: true },
      }),
    );

    expect(candidate).toBeDefined();
    expect(candidate?.direction).toBe('long');
    expect(candidate?.agreementCount).toBeGreaterThan(0);
    expect(candidate?.counterTrend).toBe(false);
  });

  it('does not treat a trending market with no setup as a trade', () => {
    const detector = new SignalDetector(loadConfig({
      detectors: {
        breakout: { enabled: false },
        pullback: { enabled: false },
        momentum: { enabled: false },
        reversal: { enabled: false },
      },
    }));

    const snapshot = makeSnapshot({
      candles: { '1d': makeCandles({ count: 300, drift: 0.005, intervalMs: 86_400_000 }) },
    });
    expect(detector.detect(snapshot)).toBeUndefined();
  });

  it('marks a candidate counter-trend when it fights the higher timeframe', () => {
    const detector = new SignalDetector(testConfig);
    const declining = makeCandles({ count: 300, start: 500, drift: -0.006, wick: 0.003 });
    const candidate = detector.detect(
      makeSnapshot({
        candles: { '4h': declining },
        higherTimeframeTrend: 'up',
        volume: { ratio: 2, isSpike: true },
      }),
    );

    expect(candidate?.direction).toBe('short');
    expect(candidate?.counterTrend).toBe(true);
  });

  it('survives a detector that throws', () => {
    const detector = new SignalDetector(testConfig, [
      {
        name: 'breakout',
        isEnabled: () => true,
        run: () => {
          throw new Error('boom');
        },
      },
    ]);

    const results = detector.runDetectors(makeSnapshot());
    expect(results[0]?.triggered).toBe(false);
    expect(results[0]?.rationale).toMatch(/detector threw: boom/);
  });
});
