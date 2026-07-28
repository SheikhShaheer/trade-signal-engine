import type { EngineConfig } from '../../config/schema.js';
import type { DetectorName, DetectorResult, MarketSnapshot } from '../../types.js';

/**
 * A detector is a pure function of a snapshot plus config. Keeping them pure is
 * what makes stage 2 unit-testable with hand-built snapshots and replayable
 * against stored history.
 */
export interface Detector {
  readonly name: DetectorName;
  isEnabled(config: EngineConfig): boolean;
  run(snapshot: MarketSnapshot, config: EngineConfig): DetectorResult;
}

export function notTriggered(
  name: DetectorName,
  rationale: string,
  evidence: Record<string, number | string | boolean> = {},
): DetectorResult {
  return { name, triggered: false, strength: 0, rationale, direction: undefined, evidence };
}
