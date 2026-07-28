import type { EngineConfig } from '../../config/schema.js';
import { clamp, normaliseRange } from '../../indicators/index.js';
import type { DetectorResult, MarketSnapshot } from '../../types.js';
import { notTriggered, type Detector } from './types.js';

/**
 * Breakout: price has closed beyond the edge of its recent range by a
 * meaningful fraction of ATR, with above-average volume.
 *
 * Volume confirmation is required, not optional. A break on thin volume is the
 * most common false positive in this family of setups, so the detector treats
 * it as no signal at all rather than a weak one.
 */
export const breakoutDetector: Detector = {
  name: 'breakout',

  isEnabled: (config: EngineConfig) => config.detectors.breakout.enabled,

  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult {
    const { lookback, minAtrClearance, minVolumeRatio } = config.detectors.breakout;
    const timeframe = config.volatility.atrTimeframe;
    const context = snapshot.timeframes[timeframe];

    if (!context) return notTriggered('breakout', `no ${timeframe} data available`);
    if (context.atr === undefined || context.atr <= 0) {
      return notTriggered('breakout', `ATR unavailable on ${timeframe}, cannot size the breakout clearance`);
    }
    if (context.candles.length < lookback + 1) {
      return notTriggered('breakout', `need ${lookback + 1} candles, have ${context.candles.length}`);
    }

    // The range excludes the breakout candle itself; otherwise the candle that
    // breaks the range also defines it and nothing can ever break out.
    const candles = context.candles;
    const priorWindow = candles.slice(candles.length - 1 - lookback, candles.length - 1);
    const rangeHigh = Math.max(...priorWindow.map((c) => c.high));
    const rangeLow = Math.min(...priorWindow.map((c) => c.low));
    const close = context.lastClose;
    const atr = context.atr;

    const upClearance = (close - rangeHigh) / atr;
    const downClearance = (rangeLow - close) / atr;
    const volumeRatio = snapshot.volume.ratio;

    const evidence = {
      timeframe,
      rangeHigh,
      rangeLow,
      close,
      atr,
      upClearanceAtr: Number(upClearance.toFixed(3)),
      downClearanceAtr: Number(downClearance.toFixed(3)),
      volumeRatio: Number(volumeRatio.toFixed(2)),
      minAtrClearance,
      minVolumeRatio,
    };

    const brokeUp = upClearance >= minAtrClearance;
    const brokeDown = downClearance >= minAtrClearance;

    if (!brokeUp && !brokeDown) {
      const best = Math.max(upClearance, downClearance);
      return notTriggered(
        'breakout',
        `price is inside the ${lookback}-candle ${timeframe} range (${rangeLow.toFixed(2)}–${rangeHigh.toFixed(2)}); ` +
          `best clearance ${best.toFixed(2)} ATR is below the ${minAtrClearance} ATR threshold`,
        evidence,
      );
    }

    if (volumeRatio < minVolumeRatio) {
      return notTriggered(
        'breakout',
        `price cleared the ${timeframe} range but volume is only ${volumeRatio.toFixed(2)}x average, ` +
          `below the ${minVolumeRatio}x confirmation threshold — treated as an unconfirmed break`,
        evidence,
      );
    }

    const direction = brokeUp ? 'long' : 'short';
    const clearance = brokeUp ? upClearance : downClearance;
    const level = brokeUp ? rangeHigh : rangeLow;

    // Clearance dominates; volume above the threshold adds a smaller bonus.
    const clearanceScore = normaliseRange(clearance, minAtrClearance, minAtrClearance + 1.0);
    const volumeScore = normaliseRange(volumeRatio, minVolumeRatio, minVolumeRatio + 1.2);
    const strength = clamp(clearanceScore * 0.7 + volumeScore * 0.3);

    return {
      name: 'breakout',
      triggered: true,
      strength,
      direction,
      rationale:
        `${timeframe} close at ${close.toFixed(2)} cleared the ${lookback}-candle ` +
        `${brokeUp ? 'high' : 'low'} of ${level.toFixed(2)} by ${clearance.toFixed(2)} ATR ` +
        `on ${volumeRatio.toFixed(2)}x average volume.`,
      evidence: { ...evidence, clearanceScore: Number(clearanceScore.toFixed(3)), volumeScore: Number(volumeScore.toFixed(3)) },
    };
  },
};
