import type { EngineConfig } from '../../config/schema.js';
import { clamp, normaliseRange } from '../../indicators/index.js';
import type { DetectorResult, MarketSnapshot } from '../../types.js';
import { notTriggered, type Detector } from './types.js';

/**
 * Trend contribution: reports the higher-timeframe trend so downstream scoring
 * can reward alignment and penalise fighting it.
 *
 * This detector never invents a setup on its own. It triggers only to state
 * "there is a definable higher-timeframe trend, and it points this way";
 * whether a candidate agrees with it is decided when the candidate is assembled.
 */
export const trendDetector: Detector = {
  name: 'trend',

  isEnabled: (config: EngineConfig) => config.detectors.trend.enabled,

  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult {
    const { higherTimeframe, fastMaPeriod, slowMaPeriod, flatThresholdPct } = config.detectors.trend;
    const context = snapshot.timeframes[higherTimeframe];

    if (!context) return notTriggered('trend', `no ${higherTimeframe} data available`);

    const fast = context.movingAverages[fastMaPeriod];
    const slow = context.movingAverages[slowMaPeriod];
    const separation = context.trendStrength;

    const evidence = {
      timeframe: higherTimeframe,
      trend: context.trend,
      fastMaPeriod,
      slowMaPeriod,
      fastMa: fast ?? 'n/a',
      slowMa: slow ?? 'n/a',
      separationPct: Number((separation * 100).toFixed(3)),
      flatThresholdPct,
      priceVsFastMa: fast === undefined ? 'n/a' : Number((snapshot.price - fast).toFixed(2)),
    };

    if (context.trend === 'flat') {
      return notTriggered(
        'trend',
        `${higherTimeframe} MA${fastMaPeriod}/MA${slowMaPeriod} separation is only ` +
          `${(separation * 100).toFixed(2)}%, inside the ${(flatThresholdPct * 100).toFixed(2)}% flat band — ` +
          `no higher-timeframe trend to align with`,
        evidence,
      );
    }

    const direction = context.trend === 'up' ? 'long' : 'short';
    // Separation of ~4% of price is a decisively trending market for crypto majors.
    const strength = clamp(normaliseRange(Math.abs(separation), flatThresholdPct, 0.04));

    return {
      name: 'trend',
      triggered: true,
      strength,
      direction,
      rationale:
        `${higherTimeframe} trend is ${context.trend}: MA${fastMaPeriod} is ` +
        `${separation > 0 ? 'above' : 'below'} MA${slowMaPeriod} by ${Math.abs(separation * 100).toFixed(2)}% of price.`,
      evidence,
    };
  },
};
