import { describe, expect, it } from 'vitest';
import {
  atr,
  clamp,
  clusterLevels,
  ema,
  findSwingHighs,
  findSwingLows,
  macd,
  normaliseRange,
  roundDownToStep,
  rsi,
  sma,
  toLogSeries,
  trueRange,
  vwap,
} from '../src/indicators/index.js';
import { makeCandles } from './fixtures.js';

describe('sma', () => {
  it('averages the last `period` values', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2, 3, 4, 5], 2)).toBe(4.5);
  });

  it('returns undefined rather than a partial average when history is short', () => {
    expect(sma([1, 2], 5)).toBeUndefined();
  });
});

describe('ema', () => {
  it('reacts to a recent jump faster than an sma does', () => {
    const jump = [10, 10, 10, 10, 10, 10, 10, 10, 10, 30];
    expect(ema(jump, 5) as number).toBeGreaterThan(sma(jump, 5) as number);
  });

  it('equals the value itself for a flat series', () => {
    expect(ema([5, 5, 5, 5, 5, 5], 3)).toBeCloseTo(5, 10);
  });
});

describe('rsi', () => {
  it('returns 100 for an unbroken advance', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(values, 14)).toBe(100);
  });

  it('returns a low reading for an unbroken decline', () => {
    const values = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(rsi(values, 14)).toBeLessThan(5);
  });

  it('returns 50 for a perfectly flat series', () => {
    expect(rsi(Array.from({ length: 30 }, () => 100), 14)).toBe(50);
  });

  it('stays inside 0..100 for a choppy series', () => {
    const values = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 3 : -2) + i * 0.1);
    const value = rsi(values, 14) as number;
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(100);
  });
});

describe('macd', () => {
  it('puts the macd line above zero in an uptrend', () => {
    const values = Array.from({ length: 120 }, (_, i) => 100 * 1.01 ** i);
    const result = macd(values, 12, 26, 9);
    expect(result).toBeDefined();
    expect((result as { macd: number }).macd).toBeGreaterThan(0);
  });

  it('returns undefined when there is not enough history for the slow ema', () => {
    expect(macd([1, 2, 3], 12, 26, 9)).toBeUndefined();
  });

  it('is symmetric between equal-rate rises and falls once run on log prices', () => {
    const up = Array.from({ length: 200 }, (_, i) => 100 * 1.006 ** i);
    const down = Array.from({ length: 200 }, (_, i) => 100 * 0.994 ** i);

    const upLog = macd(toLogSeries(up), 12, 26, 9) as { macd: number };
    const downLog = macd(toLogSeries(down), 12, 26, 9) as { macd: number };

    expect(upLog.macd).toBeGreaterThan(0);
    expect(downLog.macd).toBeLessThan(0);
    expect(Math.abs(upLog.macd + downLog.macd)).toBeLessThan(Math.abs(upLog.macd) * 0.05);
  });

  it('is not symmetric on raw prices, which is why log prices are used', () => {
    const down = Array.from({ length: 200 }, (_, i) => 100 * 0.994 ** i);
    const raw = macd(down, 12, 26, 9) as { histogram: number };
    // A decaying series shrinks the absolute EMA gap, pushing the raw-price
    // histogram positive even though price is falling steadily.
    expect(raw.histogram).toBeGreaterThan(0);
  });
});

describe('toLogSeries', () => {
  it('maps prices to their natural logs', () => {
    expect(toLogSeries([1, Math.E])).toEqual([0, 1]);
  });

  it('drops non-positive values, for which a log price is undefined', () => {
    expect(toLogSeries([1, 0, -5, Math.E])).toEqual([0, 1]);
  });
});

describe('trueRange and atr', () => {
  it('uses the gap from the previous close when it exceeds the bar range', () => {
    const candle = { openTime: 0, closeTime: 1, open: 110, high: 112, low: 108, close: 111, volume: 1 };
    expect(trueRange(candle, 100)).toBe(12);
    expect(trueRange(candle, undefined)).toBe(4);
  });

  it('is positive for a series with real ranges', () => {
    const value = atr(makeCandles({ count: 60, start: 100, drift: 0.001, wick: 0.005 }), 14) as number;
    expect(value).toBeGreaterThan(0);
  });

  it('grows when candle ranges widen', () => {
    const calm = atr(makeCandles({ count: 60, wick: 0.002 }), 14) as number;
    const wild = atr(makeCandles({ count: 60, wick: 0.02 }), 14) as number;
    expect(wild).toBeGreaterThan(calm);
  });
});

describe('vwap', () => {
  it('equals the typical price when volume is constant and price is flat', () => {
    const candles = makeCandles({ count: 20, start: 100, drift: 0, wick: 0 });
    expect(vwap(candles, 20)).toBeCloseTo(100, 6);
  });

  it('returns undefined when the window has no volume', () => {
    const candles = makeCandles({ count: 20, volume: 0 });
    expect(vwap(candles, 20)).toBeUndefined();
  });
});

describe('swing detection', () => {
  const candles = makeCandles({ count: 11, drift: 0, wick: 0 });

  it('finds a confirmed pivot high', () => {
    const withPeak = [...candles];
    withPeak[5] = { ...(withPeak[5] as (typeof candles)[number]), high: 200 };
    const highs = findSwingHighs(withPeak, 2);
    expect(highs.map((h) => h.index)).toContain(5);
  });

  it('finds a confirmed pivot low', () => {
    const withTrough = [...candles];
    withTrough[5] = { ...(withTrough[5] as (typeof candles)[number]), low: 1 };
    const lows = findSwingLows(withTrough, 2);
    expect(lows.map((l) => l.index)).toContain(5);
  });

  it('ignores the unconfirmed final candles', () => {
    const withEdgePeak = [...candles];
    withEdgePeak[10] = { ...(withEdgePeak[10] as (typeof candles)[number]), high: 500 };
    expect(findSwingHighs(withEdgePeak, 2).map((h) => h.index)).not.toContain(10);
  });
});

describe('clusterLevels', () => {
  it('merges nearby pivots and counts touches', () => {
    const clusters = clusterLevels(
      [
        { index: 0, price: 100, strength: 2 },
        { index: 1, price: 100.5, strength: 2 },
        { index: 2, price: 130, strength: 2 },
      ],
      1,
    );
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ touches: 2 });
    expect(clusters[0]?.price).toBeCloseTo(100.25, 6);
    expect(clusters[1]).toMatchObject({ price: 130, touches: 1 });
  });
});

describe('scaling helpers', () => {
  it('clamps to the requested bounds', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(Number.NaN)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('maps a value across a band and clamps at both ends', () => {
    expect(normaliseRange(1.5, 1.5, 3)).toBe(0);
    expect(normaliseRange(3, 1.5, 3)).toBe(1);
    expect(normaliseRange(2.25, 1.5, 3)).toBeCloseTo(0.5, 6);
    expect(normaliseRange(0, 1.5, 3)).toBe(0);
  });

  it('rounds quantity down to a whole exchange step', () => {
    expect(roundDownToStep(1.23456, 0.001)).toBeCloseTo(1.234, 6);
    expect(roundDownToStep(0.00009, 0.0001)).toBe(0);
    expect(roundDownToStep(5, 1)).toBe(5);
  });
});
