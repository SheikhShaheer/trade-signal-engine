import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import { clamp, roundTo } from '../indicators/index.js';
import type {
  Direction,
  KeyLevel,
  MarketSnapshot,
  SignalCandidate,
  TradePlan,
} from '../types.js';

export interface PlanRejection {
  reason: string;
  detail: Record<string, number | string>;
}

export type PlanResult = { ok: true; plan: TradePlan } | { ok: false; rejection: PlanRejection };

/**
 * Stage 3. Turns a SignalCandidate into a concrete, falsifiable plan.
 *
 * Two rules drive everything here:
 *  - Risk/reward is computed from entry, stop and first target. It is never
 *    asserted, and a plan whose computed R:R is too low is rejected rather
 *    than having its targets stretched to look acceptable.
 *  - Invalidation is a specific price and timeframe a human can check on a
 *    chart, not a phrase like "if the setup fails".
 */
export class TradePlanBuilder {
  constructor(private readonly config: EngineConfig) {}

  build(candidate: SignalCandidate, snapshot: MarketSnapshot, instrument: InstrumentConfig): PlanResult {
    const timeframe = this.config.volatility.atrTimeframe;
    const context = snapshot.timeframes[timeframe];

    if (!context) {
      return { ok: false, rejection: { reason: `no ${timeframe} context in snapshot`, detail: {} } };
    }
    if (context.atr === undefined || context.atr <= 0) {
      return {
        ok: false,
        rejection: {
          reason: `ATR unavailable on ${timeframe}, so stop distance cannot be derived from volatility`,
          detail: { timeframe },
        },
      };
    }

    const { direction } = candidate;
    const atr = context.atr;
    const price = snapshot.price;
    const decimals = instrument.priceDecimals;
    const { entryZoneAtrMultiple, stopAtrMultiple, targetRMultiples, minAcceptableRiskReward } = this.config.planning;

    // Entry is a zone around the current price, not a single tick, because a
    // human filling this manually will not get the exact print.
    const halfWidth = atr * entryZoneAtrMultiple;
    const entryZone = {
      low: roundTo(price - halfWidth, decimals),
      high: roundTo(price + halfWidth, decimals),
    };
    const referenceEntry = roundTo((entryZone.low + entryZone.high) / 2, decimals);

    const stopLoss = this.deriveStop(direction, referenceEntry, atr, stopAtrMultiple, snapshot.keyLevels, decimals);

    const riskPerUnit = Math.abs(referenceEntry - stopLoss);
    if (riskPerUnit <= 0) {
      return {
        ok: false,
        rejection: {
          reason: 'stop resolved to the entry price, giving zero risk distance',
          detail: { referenceEntry, stopLoss },
        },
      };
    }

    // Stop must sit on the correct side of entry; otherwise the plan is
    // internally inconsistent and every downstream number is meaningless.
    if ((direction === 'long' && stopLoss >= referenceEntry) || (direction === 'short' && stopLoss <= referenceEntry)) {
      return {
        ok: false,
        rejection: {
          reason: `stop ${stopLoss} is on the wrong side of entry ${referenceEntry} for a ${direction}`,
          detail: { referenceEntry, stopLoss, direction },
        },
      };
    }

    const targets = targetRMultiples
      .map((multiple) =>
        roundTo(
          direction === 'long' ? referenceEntry + riskPerUnit * multiple : referenceEntry - riskPerUnit * multiple,
          decimals,
        ),
      )
      .filter((target) => target > 0);

    if (targets.length === 0) {
      return {
        ok: false,
        rejection: { reason: 'all computed targets were non-positive', detail: { referenceEntry, riskPerUnit } },
      };
    }

    const firstTarget = targets[0] as number;
    const reward = Math.abs(firstTarget - referenceEntry);
    const riskRewardRatio = roundTo(reward / riskPerUnit, 2);

    if (riskRewardRatio < minAcceptableRiskReward) {
      return {
        ok: false,
        rejection: {
          reason:
            `computed R:R of ${riskRewardRatio} is below the ${minAcceptableRiskReward} minimum ` +
            `(risk ${roundTo(riskPerUnit, decimals)}, reward ${roundTo(reward, decimals)})`,
          detail: { riskRewardRatio, minAcceptableRiskReward, riskPerUnit, reward },
        },
      };
    }

    const nearestObstacle = this.findObstacle(direction, referenceEntry, firstTarget, snapshot.keyLevels);
    if (nearestObstacle) {
      return {
        ok: false,
        rejection: {
          reason:
            `a ${nearestObstacle.kind} level at ${nearestObstacle.price} sits between entry ${referenceEntry} ` +
            `and the first target ${firstTarget}, so TP1 is not a clean run`,
          detail: { level: nearestObstacle.price, kind: nearestObstacle.kind, firstTarget },
        },
      };
    }

    return {
      ok: true,
      plan: {
        instrument: candidate.instrument,
        signalId: candidate.id,
        direction,
        entryZone,
        stopLoss,
        targets,
        riskRewardRatio,
        invalidation: this.buildInvalidation(direction, stopLoss, timeframe, snapshot.keyLevels, decimals),
        timeframe,
        confidence: this.computeConfidence(candidate, riskRewardRatio),
        timestamp: new Date().toISOString(),
        referenceEntry,
        riskPerUnit: roundTo(riskPerUnit, decimals),
        atrUsed: roundTo(atr, decimals),
      },
    };
  }

  /**
   * Stop is ATR-based, then pushed just beyond a nearby structural level if one
   * sits inside the ATR stop. Placing a stop exactly at an obvious level is how
   * it gets swept on a wick.
   */
  private deriveStop(
    direction: Direction,
    entry: number,
    atr: number,
    stopAtrMultiple: number,
    levels: readonly KeyLevel[],
    decimals: number,
  ): number {
    const atrStop = direction === 'long' ? entry - atr * stopAtrMultiple : entry + atr * stopAtrMultiple;
    const buffer = atr * 0.1;

    const candidates = levels.filter((level) =>
      direction === 'long'
        ? level.price < entry && level.price > atrStop && (level.kind === 'support' || level.kind === 'recent-low')
        : level.price > entry && level.price < atrStop && (level.kind === 'resistance' || level.kind === 'recent-high'),
    );

    if (candidates.length === 0) return roundTo(atrStop, decimals);

    const structural =
      direction === 'long'
        ? Math.min(...candidates.map((l) => l.price)) - buffer
        : Math.max(...candidates.map((l) => l.price)) + buffer;

    // Never widen past the ATR stop: that would silently increase risk beyond
    // what the volatility model allows.
    return roundTo(direction === 'long' ? Math.max(structural, atrStop) : Math.min(structural, atrStop), decimals);
  }

  /** A meaningful level between entry and TP1 that TP1 would have to fight through. */
  private findObstacle(
    direction: Direction,
    entry: number,
    firstTarget: number,
    levels: readonly KeyLevel[],
  ): KeyLevel | undefined {
    const relevant = levels.filter((level) => {
      if (level.touches < 2) return false;
      if (direction === 'long') return level.kind === 'resistance' && level.price > entry && level.price < firstTarget;
      return level.kind === 'support' && level.price < entry && level.price > firstTarget;
    });
    if (relevant.length === 0) return undefined;
    return relevant.sort((a, b) => b.touches - a.touches)[0];
  }

  /**
   * A checkable kill condition: a close beyond the stop on the plan's own
   * timeframe, plus the structural level it corresponds to when there is one.
   */
  private buildInvalidation(
    direction: Direction,
    stopLoss: number,
    timeframe: string,
    levels: readonly KeyLevel[],
    decimals: number,
  ): string {
    const side = direction === 'long' ? 'below' : 'above';
    const structural = levels
      .filter((level) =>
        direction === 'long'
          ? (level.kind === 'support' || level.kind === 'recent-low') && Math.abs(level.price - stopLoss) < stopLoss * 0.02
          : (level.kind === 'resistance' || level.kind === 'recent-high') && Math.abs(level.price - stopLoss) < stopLoss * 0.02,
      )
      .sort((a, b) => b.touches - a.touches)[0];

    const base = `${timeframe} close ${side} ${roundTo(stopLoss, decimals)}`;
    return structural
      ? `${base}, which would break the ${structural.kind} at ${roundTo(structural.price, decimals)} (${structural.touches} touches)`
      : base;
  }

  /**
   * Pre-risk-gate confidence. Detector strength is the bulk of it, adjusted for
   * how many detectors independently agree, whether any disagree, and whether
   * the idea fights the higher-timeframe trend.
   */
  private computeConfidence(candidate: SignalCandidate, riskRewardRatio: number): number {
    const triggered = candidate.triggeredDetectors;
    const meanStrength = triggered.reduce((acc, d) => acc + d.strength, 0) / Math.max(1, triggered.length);
    const agreementBonus = Math.min(0.2, Math.max(0, candidate.agreementCount - 1) * 0.08);
    const disagreementPenalty = candidate.disagreementCount * 0.12;
    const counterTrendPenalty = candidate.counterTrend ? 0.2 : 0;
    const rrBonus = clamp((riskRewardRatio - 1) / 4) * 0.1;

    return roundTo(
      clamp(meanStrength * 0.75 + agreementBonus + rrBonus - disagreementPenalty - counterTrendPenalty),
      3,
    );
  }
}
