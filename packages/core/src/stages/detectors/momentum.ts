import type { EngineConfig } from '../../config/schema.js';
import { clamp, normaliseRange } from '../../indicators/index.js';
import type { DetectorResult, MarketSnapshot } from '../../types.js';
import { notTriggered, type Detector } from './types.js';

/**
 * Momentum: RSI is on one side of neutral and MACD agrees, with no strong
 * near-term impulse running the other way.
 *
 * Direction comes from the MACD line's sign — the fast EMA above or below the
 * slow one — not from the histogram. The histogram is the difference between
 * MACD and its signal line, which measures acceleration; a healthy steady trend
 * has acceleration near zero, so reading direction from it would miss exactly
 * the moves this detector exists to catch. The histogram is used instead to
 * reject moves that are actively rolling over.
 *
 * MACD arrives already computed on log prices (see the scanner), which is what
 * makes these readings symmetric between rising and falling markets.
 */
export const momentumDetector: Detector = {
  name: 'momentum',

  isEnabled: (config: EngineConfig) => config.detectors.momentum.enabled,

  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult {
    const { rsiBullish, rsiBearish, maxCounterImpulseRatio } = config.detectors.momentum;
    const timeframe = config.volatility.atrTimeframe;
    const context = snapshot.timeframes[timeframe];

    if (!context) return notTriggered('momentum', `no ${timeframe} data available`);
    if (context.rsi === undefined) return notTriggered('momentum', `RSI unavailable on ${timeframe}`);
    if (!context.macd) return notTriggered('momentum', `MACD unavailable on ${timeframe}`);

    const rsi = context.rsi;
    const { macd, signal, histogram } = context.macd;

    const bullish = rsi >= rsiBullish && macd > 0;
    const bearish = rsi <= rsiBearish && macd < 0;

    // Positive when the near-term impulse runs with the MACD's direction.
    const directionalImpulse = macd > 0 ? histogram : -histogram;
    const impulseRatio = Math.abs(macd) > 1e-12 ? directionalImpulse / Math.abs(macd) : 0;

    const evidence = {
      timeframe,
      rsi: Number(rsi.toFixed(2)),
      macd: Number(macd.toFixed(6)),
      signal: Number(signal.toFixed(6)),
      histogram: Number(histogram.toFixed(6)),
      impulseRatio: Number(impulseRatio.toFixed(3)),
      maxCounterImpulseRatio,
      rsiBullish,
      rsiBearish,
    };

    if (!bullish && !bearish) {
      return notTriggered(
        'momentum',
        `RSI ${rsi.toFixed(1)} and the MACD line at ${macd.toFixed(4)} do not agree on a direction ` +
          `(need RSI ≥ ${rsiBullish} with MACD above zero, or RSI ≤ ${rsiBearish} with MACD below it)`,
        evidence,
      );
    }

    if (impulseRatio < -maxCounterImpulseRatio) {
      return notTriggered(
        'momentum',
        `RSI ${rsi.toFixed(1)} and MACD point ${bullish ? 'up' : 'down'} but the histogram is running ` +
          `${Math.abs(impulseRatio * 100).toFixed(0)}% of |MACD| against that direction, past the ` +
          `${(maxCounterImpulseRatio * 100).toFixed(0)}% limit — the move is rolling over rather than continuing`,
        evidence,
      );
    }

    const direction = bullish ? 'long' : 'short';
    // Distance past the RSI threshold, capped so an extreme reading does not
    // dominate; extremes are the reversal detector's territory.
    const rsiScore = bullish
      ? normaliseRange(rsi, rsiBullish, 75)
      : normaliseRange(rsiBearish - rsi, 0, rsiBearish - 25);
    // MACD is in log units, so 2% separation of the EMAs is a strong reading
    // regardless of the instrument's price.
    const macdScore = normaliseRange(Math.abs(macd), 0, 0.02);
    const accelerating = impulseRatio > 0;
    const strength = clamp(rsiScore * 0.5 + macdScore * 0.35 + (accelerating ? 0.15 : 0));

    return {
      name: 'momentum',
      triggered: true,
      strength,
      direction,
      rationale:
        `${timeframe} RSI at ${rsi.toFixed(1)} with the MACD line at ${macd.toFixed(4)} ` +
        `${accelerating ? 'and accelerating' : 'and holding'} confirms ` +
        `${direction === 'long' ? 'upward' : 'downward'} momentum.`,
      evidence: {
        ...evidence,
        accelerating,
        rsiScore: Number(rsiScore.toFixed(3)),
        macdScore: Number(macdScore.toFixed(3)),
      },
    };
  },
};
