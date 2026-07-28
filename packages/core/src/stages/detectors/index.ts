import type { EngineConfig } from '../../config/schema.js';
import type { Direction, DetectorResult, MarketSnapshot, SignalCandidate } from '../../types.js';
import { breakoutDetector } from './breakout.js';
import { momentumDetector } from './momentum.js';
import { pullbackDetector } from './pullback.js';
import { reversalDetector } from './reversal.js';
import { trendDetector } from './trend.js';
import type { Detector } from './types.js';

export { breakoutDetector } from './breakout.js';
export { pullbackDetector } from './pullback.js';
export { momentumDetector } from './momentum.js';
export { trendDetector } from './trend.js';
export { reversalDetector } from './reversal.js';
export { notTriggered, type Detector } from './types.js';

export const allDetectors: readonly Detector[] = [
  breakoutDetector,
  pullbackDetector,
  momentumDetector,
  trendDetector,
  reversalDetector,
];

/**
 * Stage 2. Runs every enabled detector against a snapshot and assembles a
 * SignalCandidate when at least one detector fires with a direction.
 *
 * Results from detectors that did not fire are kept, not discarded: "why
 * nothing triggered" is exactly what you want when auditing a missed move.
 */
export class SignalDetector {
  constructor(
    private readonly config: EngineConfig,
    private readonly detectors: readonly Detector[] = allDetectors,
  ) {}

  /** All detector outputs, including non-triggered ones. */
  runDetectors(snapshot: MarketSnapshot): DetectorResult[] {
    return this.detectors
      .filter((detector) => detector.isEnabled(this.config))
      .map((detector) => {
        try {
          return detector.run(snapshot, this.config);
        } catch (error) {
          return {
            name: detector.name,
            triggered: false,
            strength: 0,
            direction: undefined,
            rationale: `detector threw: ${(error as Error).message}`,
            evidence: { error: (error as Error).message },
          } satisfies DetectorResult;
        }
      });
  }

  /**
   * Returns undefined when nothing actionable fired. `trend` is excluded from
   * the trigger test because it describes context rather than a setup: a
   * trending market with no setup in it is not a trade.
   */
  detect(snapshot: MarketSnapshot): SignalCandidate | undefined {
    const results = this.runDetectors(snapshot);
    const triggered = results.filter((r) => r.triggered && r.direction !== undefined);
    const setupTriggers = triggered.filter((r) => r.name !== 'trend');
    if (setupTriggers.length === 0) return undefined;

    const direction = resolveDirection(setupTriggers);
    if (!direction) return undefined;

    const agreementCount = triggered.filter((r) => r.direction === direction).length;
    const disagreementCount = triggered.filter((r) => r.direction !== undefined && r.direction !== direction).length;

    const htfTrend = snapshot.higherTimeframeTrend;
    const counterTrend =
      (direction === 'long' && htfTrend === 'down') || (direction === 'short' && htfTrend === 'up');

    return {
      instrument: snapshot.instrument,
      capturedAt: snapshot.capturedAt,
      snapshotId: snapshot.id,
      detectors: results,
      triggeredDetectors: triggered,
      direction,
      agreementCount,
      disagreementCount,
      counterTrend,
    };
  }
}

/**
 * Net direction by strength, not by count: one high-conviction breakout should
 * outweigh a marginal opposing signal. A near-tie means the detectors genuinely
 * disagree and no candidate is produced.
 */
function resolveDirection(triggered: readonly DetectorResult[]): Direction | undefined {
  let longWeight = 0;
  let shortWeight = 0;
  for (const result of triggered) {
    if (result.direction === 'long') longWeight += result.strength;
    else if (result.direction === 'short') shortWeight += result.strength;
  }
  const total = longWeight + shortWeight;
  if (total === 0) {
    // Every triggered detector scored 0 strength; fall back to a count.
    const longs = triggered.filter((r) => r.direction === 'long').length;
    const shorts = triggered.filter((r) => r.direction === 'short').length;
    if (longs === shorts) return undefined;
    return longs > shorts ? 'long' : 'short';
  }
  if (Math.abs(longWeight - shortWeight) / total < 0.15) return undefined;
  return longWeight > shortWeight ? 'long' : 'short';
}
