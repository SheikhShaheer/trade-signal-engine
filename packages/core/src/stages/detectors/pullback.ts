import type { EngineConfig } from '../../config/schema.js';
import { clamp, normaliseRange } from '../../indicators/index.js';
import type { Candle, DetectorResult, MarketSnapshot } from '../../types.js';
import { notTriggered, type Detector } from './types.js';

/**
 * Pullback: price has retraced into a moving average inside an established
 * trend, and is trading with that trend rather than against it.
 *
 * The trend requirement is structural. Without it, "price near the 20 MA" is
 * true roughly half the time and carries no information.
 */
export const pullbackDetector: Detector = {
  name: 'pullback',

  isEnabled: (config: EngineConfig) => config.detectors.pullback.enabled,

  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult {
    const { maPeriod, maxAtrDistance } = config.detectors.pullback;
    const timeframe = config.volatility.atrTimeframe;
    const context = snapshot.timeframes[timeframe];

    if (!context) return notTriggered('pullback', `no ${timeframe} data available`);
    if (context.atr === undefined || context.atr <= 0) {
      return notTriggered('pullback', `ATR unavailable on ${timeframe}`);
    }

    const ma = context.movingAverages[maPeriod];
    if (ma === undefined) {
      return notTriggered('pullback', `MA${maPeriod} unavailable on ${timeframe} (insufficient history)`);
    }

    const trend = context.trend;
    const price = snapshot.price;
    const atr = context.atr;
    const distanceAtr = Math.abs(price - ma) / atr;

    const evidence = {
      timeframe,
      maPeriod,
      ma,
      price,
      atr,
      distanceAtr: Number(distanceAtr.toFixed(3)),
      maxAtrDistance,
      trend,
      higherTimeframeTrend: snapshot.higherTimeframeTrend,
    };

    if (trend === 'flat') {
      return notTriggered(
        'pullback',
        `${timeframe} trend is flat, so a touch of MA${maPeriod} is not a pullback in a trend`,
        evidence,
      );
    }
    if (distanceAtr > maxAtrDistance) {
      return notTriggered(
        'pullback',
        `price is ${distanceAtr.toFixed(2)} ATR from MA${maPeriod}, beyond the ${maxAtrDistance} ATR touch threshold`,
        evidence,
      );
    }

    // In an uptrend a pullback is a long; the retracement should come from
    // above the MA, not a breakdown through it.
    const direction = trend === 'up' ? 'long' : 'short';
    const brokeThrough = direction === 'long' ? price < ma : price > ma;

    const candles = context.candles;
    const recent = candles.slice(Math.max(0, candles.length - 5)) as Candle[];
    const pulledBackFromExtreme =
      direction === 'long'
        ? Math.max(...recent.map((c) => c.high)) > price
        : Math.min(...recent.map((c) => c.low)) < price;

    if (!pulledBackFromExtreme) {
      return notTriggered(
        'pullback',
        `price is at MA${maPeriod} but is making new ${direction === 'long' ? 'highs' : 'lows'}, ` +
          `so there is no retracement to buy`,
        evidence,
      );
    }

    const proximityScore = 1 - normaliseRange(distanceAtr, 0, maxAtrDistance);
    const trendScore = clamp(Math.abs(context.trendStrength) / 0.05);
    const alignmentBonus = snapshot.higherTimeframeTrend === trend ? 0.15 : 0;
    // A close beyond the MA is a weaker version of the same idea, not a
    // different one: the level is being tested rather than holding cleanly.
    const strength = clamp((proximityScore * 0.55 + trendScore * 0.3 + alignmentBonus) * (brokeThrough ? 0.75 : 1));

    return {
      name: 'pullback',
      triggered: true,
      strength,
      direction,
      rationale:
        `${timeframe} trend is ${trend} and price at ${price.toFixed(2)} has retraced to within ` +
        `${distanceAtr.toFixed(2)} ATR of MA${maPeriod} (${ma.toFixed(2)})` +
        `${brokeThrough ? ', trading slightly through it' : ', holding above it'}.`,
      evidence: {
        ...evidence,
        brokeThrough,
        proximityScore: Number(proximityScore.toFixed(3)),
        trendScore: Number(trendScore.toFixed(3)),
      },
    };
  },
};
