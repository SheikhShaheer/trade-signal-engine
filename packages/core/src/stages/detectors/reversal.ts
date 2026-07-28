import type { EngineConfig } from '../../config/schema.js';
import { clamp, normaliseRange, rsi as computeRsi } from '../../indicators/index.js';
import type { Candle, DetectorResult, MarketSnapshot } from '../../types.js';
import { notTriggered, type Detector } from './types.js';

/**
 * Reversal: exhaustion at a key level. Requires two of three pieces of
 * evidence — an RSI extreme, a rejection wick, and RSI/price divergence —
 * because any one alone fires constantly in a trending market.
 */
export const reversalDetector: Detector = {
  name: 'reversal',

  isEnabled: (config: EngineConfig) => config.detectors.reversal.enabled,

  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult {
    const { overbought, oversold, levelLookback, minWickRatio, rsiPeriod } = config.detectors.reversal;
    const timeframe = config.volatility.atrTimeframe;
    const context = snapshot.timeframes[timeframe];

    if (!context) return notTriggered('reversal', `no ${timeframe} data available`);
    if (context.rsi === undefined) return notTriggered('reversal', `RSI unavailable on ${timeframe}`);
    if (context.candles.length < levelLookback) {
      return notTriggered('reversal', `need ${levelLookback} candles, have ${context.candles.length}`);
    }

    const rsi = context.rsi;
    const candles = context.candles;
    const last = candles[candles.length - 1] as Candle;
    const range = last.high - last.low;

    const upperWickRatio = range > 0 ? (last.high - Math.max(last.open, last.close)) / range : 0;
    const lowerWickRatio = range > 0 ? (Math.min(last.open, last.close) - last.low) / range : 0;

    const divergence = detectDivergence(candles, rsiPeriod);

    const bearishRsi = rsi >= overbought;
    const bullishRsi = rsi <= oversold;
    const bearishWick = upperWickRatio >= minWickRatio;
    const bullishWick = lowerWickRatio >= minWickRatio;
    const bearishDivergence = divergence === 'bearish';
    const bullishDivergence = divergence === 'bullish';

    const bearishEvidence = [bearishRsi, bearishWick, bearishDivergence].filter(Boolean).length;
    const bullishEvidence = [bullishRsi, bullishWick, bullishDivergence].filter(Boolean).length;

    // Rejection has to happen somewhere that matters, otherwise it is noise.
    const atResistance = snapshot.keyLevels.some((l) => l.isTouching && (l.kind === 'resistance' || l.kind === 'recent-high'));
    const atSupport = snapshot.keyLevels.some((l) => l.isTouching && (l.kind === 'support' || l.kind === 'recent-low'));

    const evidence = {
      timeframe,
      rsi: Number(rsi.toFixed(2)),
      overbought,
      oversold,
      upperWickRatio: Number(upperWickRatio.toFixed(3)),
      lowerWickRatio: Number(lowerWickRatio.toFixed(3)),
      minWickRatio,
      divergence: divergence ?? 'none',
      bearishEvidence,
      bullishEvidence,
      atResistance,
      atSupport,
    };

    const bearishQualifies = bearishEvidence >= 2 && atResistance;
    const bullishQualifies = bullishEvidence >= 2 && atSupport;

    if (!bearishQualifies && !bullishQualifies) {
      const detail =
        bearishEvidence >= 2 || bullishEvidence >= 2
          ? `exhaustion signals present but price is not at a key level, so there is nothing to reject from`
          : `only ${Math.max(bearishEvidence, bullishEvidence)} of the 3 exhaustion signals present (need 2)`;
      return notTriggered('reversal', `${detail} on ${timeframe}`, evidence);
    }

    // When both sides qualify, trust the one with more evidence; a tie is
    // genuinely ambiguous and should not produce a signal.
    if (bearishQualifies && bullishQualifies && bearishEvidence === bullishEvidence) {
      return notTriggered(
        'reversal',
        `exhaustion evidence is symmetrical in both directions on ${timeframe}, which is not a tradable reversal`,
        evidence,
      );
    }

    const isBearish = bearishQualifies && (!bullishQualifies || bearishEvidence > bullishEvidence);
    const direction = isBearish ? 'short' : 'long';
    const count = isBearish ? bearishEvidence : bullishEvidence;
    const wickRatio = isBearish ? upperWickRatio : lowerWickRatio;
    const rsiExtremity = isBearish ? normaliseRange(rsi, overbought, 90) : normaliseRange(oversold - rsi, 0, oversold - 10);

    const strength = clamp(
      normaliseRange(count, 2, 3) * 0.4 + rsiExtremity * 0.3 + normaliseRange(wickRatio, minWickRatio, 0.9) * 0.3,
    );

    const parts: string[] = [];
    if (isBearish ? bearishRsi : bullishRsi) parts.push(`RSI at ${rsi.toFixed(1)}`);
    if (isBearish ? bearishWick : bullishWick) parts.push(`a ${(wickRatio * 100).toFixed(0)}% rejection wick`);
    if (isBearish ? bearishDivergence : bullishDivergence) parts.push(`${divergence} RSI divergence`);

    return {
      name: 'reversal',
      triggered: true,
      strength,
      direction,
      rationale:
        `${timeframe} shows ${parts.join(', ')} at ${isBearish ? 'resistance' : 'support'}, ` +
        `pointing to a ${direction === 'short' ? 'downside' : 'upside'} reversal.`,
      evidence: { ...evidence, rsiExtremity: Number(rsiExtremity.toFixed(3)) },
    };
  },
};

/**
 * Classic two-pivot divergence: price makes a higher high while RSI makes a
 * lower high (bearish), or the mirror image (bullish). Compares the last two
 * 10-candle segments, which is coarse but checkable.
 */
function detectDivergence(candles: readonly Candle[], rsiPeriod: number): 'bullish' | 'bearish' | undefined {
  const segment = 10;
  if (candles.length < rsiPeriod + segment * 2 + 1) return undefined;

  const closes = candles.map((c) => c.close);
  const recent = candles.slice(candles.length - segment);
  const prior = candles.slice(candles.length - segment * 2, candles.length - segment);

  const recentRsi = computeRsi(closes, rsiPeriod);
  const priorRsi = computeRsi(closes.slice(0, closes.length - segment), rsiPeriod);
  if (recentRsi === undefined || priorRsi === undefined) return undefined;

  const recentHigh = Math.max(...recent.map((c) => c.high));
  const priorHigh = Math.max(...prior.map((c) => c.high));
  const recentLow = Math.min(...recent.map((c) => c.low));
  const priorLow = Math.min(...prior.map((c) => c.low));

  if (recentHigh > priorHigh && recentRsi < priorRsi - 2) return 'bearish';
  if (recentLow < priorLow && recentRsi > priorRsi + 2) return 'bullish';
  return undefined;
}
