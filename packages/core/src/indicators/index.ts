import type { Candle } from '../types.js';

/**
 * Pure indicator maths. Every function returns `undefined` rather than a
 * partial value when there is not enough history, so callers must decide
 * explicitly what to do with insufficient data instead of scoring on noise.
 */

export function sma(values: readonly number[], period: number): number | undefined {
  if (period <= 0 || values.length < period) return undefined;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i += 1) sum += values[i] as number;
  return sum / period;
}

/** Full EMA series, seeded with an SMA of the first `period` values. */
export function emaSeries(values: readonly number[], period: number): number[] | undefined {
  if (period <= 0 || values.length < period) return undefined;
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = sma(values.slice(0, period), period) as number;
  out.push(prev);
  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function ema(values: readonly number[], period: number): number | undefined {
  const series = emaSeries(values, period);
  return series ? series[series.length - 1] : undefined;
}

/** Wilder's RSI, the smoothing used by charting platforms. */
export function rsi(values: readonly number[], period: number): number | undefined {
  if (period <= 0 || values.length < period + 1) return undefined;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

export function macd(
  values: readonly number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): MacdValue | undefined {
  const fast = emaSeries(values, fastPeriod);
  const slow = emaSeries(values, slowPeriod);
  if (!fast || !slow) return undefined;
  // Align: the fast series starts (slowPeriod - fastPeriod) bars earlier.
  const offset = fast.length - slow.length;
  const macdLine: number[] = [];
  for (let i = 0; i < slow.length; i += 1) {
    macdLine.push((fast[i + offset] as number) - (slow[i] as number));
  }
  const signalSeries = emaSeries(macdLine, signalPeriod);
  if (!signalSeries) return undefined;
  const macdNow = macdLine[macdLine.length - 1] as number;
  const signalNow = signalSeries[signalSeries.length - 1] as number;
  return { macd: macdNow, signal: signalNow, histogram: macdNow - signalNow };
}

/** True range of `candle` relative to the previous close. */
export function trueRange(candle: Candle, previousClose: number | undefined): number {
  const highLow = candle.high - candle.low;
  if (previousClose === undefined) return highLow;
  return Math.max(highLow, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
}

/** Wilder-smoothed ATR series, one value per candle from index `period` on. */
export function atrSeries(candles: readonly Candle[], period: number): number[] | undefined {
  if (period <= 0 || candles.length < period + 1) return undefined;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i += 1) {
    trs.push(trueRange(candles[i] as Candle, (candles[i - 1] as Candle).close));
  }
  if (trs.length < period) return undefined;
  const out: number[] = [];
  let prev = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < trs.length; i += 1) {
    prev = (prev * (period - 1) + (trs[i] as number)) / period;
    out.push(prev);
  }
  return out;
}

export function atr(candles: readonly Candle[], period: number): number | undefined {
  const series = atrSeries(candles, period);
  return series ? series[series.length - 1] : undefined;
}

/** Session-less rolling VWAP over the last `period` candles using typical price. */
export function vwap(candles: readonly Candle[], period: number): number | undefined {
  if (period <= 0 || candles.length < period) return undefined;
  let pv = 0;
  let vol = 0;
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const c = candles[i] as Candle;
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
  }
  if (vol === 0) return undefined;
  return pv / vol;
}

export interface SwingPoint {
  index: number;
  price: number;
  /** How many candles on each side confirm the pivot. */
  strength: number;
}

/**
 * Fractal pivots: a high with `width` lower highs on both sides (and the
 * mirror for lows). Excludes the last `width` candles, which cannot be
 * confirmed yet.
 */
export function findSwingHighs(candles: readonly Candle[], width = 2): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = width; i < candles.length - width; i += 1) {
    const pivot = candles[i] as Candle;
    let isHigh = true;
    for (let j = 1; j <= width; j += 1) {
      if ((candles[i - j] as Candle).high >= pivot.high || (candles[i + j] as Candle).high >= pivot.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) out.push({ index: i, price: pivot.high, strength: width });
  }
  return out;
}

export function findSwingLows(candles: readonly Candle[], width = 2): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = width; i < candles.length - width; i += 1) {
    const pivot = candles[i] as Candle;
    let isLow = true;
    for (let j = 1; j <= width; j += 1) {
      if ((candles[i - j] as Candle).low <= pivot.low || (candles[i + j] as Candle).low <= pivot.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) out.push({ index: i, price: pivot.low, strength: width });
  }
  return out;
}

/**
 * Collapse nearby swing points into single levels, counting touches. Two
 * pivots within `tolerance` (absolute price) are the same level.
 */
export function clusterLevels(points: readonly SwingPoint[], tolerance: number): { price: number; touches: number }[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters: { prices: number[] }[] = [{ prices: [sorted[0]!.price] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const price = sorted[i]!.price;
    const current = clusters[clusters.length - 1]!;
    const reference = current.prices[current.prices.length - 1]!;
    if (Math.abs(price - reference) <= tolerance) current.prices.push(price);
    else clusters.push({ prices: [price] });
  }
  return clusters.map((c) => ({
    price: c.prices.reduce((a, b) => a + b, 0) / c.prices.length,
    touches: c.prices.length,
  }));
}

/**
 * Natural log of each value, for indicators that should be scale-free.
 *
 * MACD on raw prices is not symmetric between rising and falling markets: a
 * constant-percentage decline shrinks the absolute distance between two EMAs,
 * so the histogram drifts positive even while price falls steadily. In log
 * space a constant-percentage move is a constant slope either way, which is
 * what a momentum reading should measure. Non-positive values are dropped,
 * since a log price is undefined for them.
 */
export function toLogSeries(values: readonly number[]): number[] {
  return values.filter((v) => v > 0).map((v) => Math.log(v));
}

export function standardDeviation(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function clamp(value: number, min = 0, max = 1): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Map `value` onto 0..1 across [floor, ceiling], clamped at both ends. */
export function normaliseRange(value: number, floor: number, ceiling: number): number {
  if (ceiling === floor) return value >= ceiling ? 1 : 0;
  return clamp((value - floor) / (ceiling - floor));
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Round down to a whole multiple of `step`, as exchanges require. */
export function roundDownToStep(value: number, step: number): number {
  if (step <= 0) return value;
  const steps = Math.floor(value / step + 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return roundTo(steps * step, decimals);
}
