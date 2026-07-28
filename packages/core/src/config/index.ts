import { defaultConfig } from './default.js';
import { engineConfigSchema, type EngineConfig } from './schema.js';

export * from './schema.js';
export { defaultConfig } from './default.js';
export { getEnv, type Env } from './env.js';

type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(base: T, override: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value;
  }
  return out as T;
}

let cached: EngineConfig | undefined;

/**
 * Validated engine config. Overrides are for tests and the backtester; the
 * running system always uses the file defaults so limits stay auditable.
 */
export function loadConfig(overrides?: DeepPartial<EngineConfig>): EngineConfig {
  if (!overrides && cached) return cached;
  const merged = overrides ? mergeDeep(defaultConfig, overrides) : defaultConfig;
  const parsed = engineConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid engine configuration:\n${issues}`);
  }
  assertCoherent(parsed.data);
  if (!overrides) cached = parsed.data;
  return parsed.data;
}

/**
 * Cross-field sanity checks the per-field schema cannot express. These are
 * config bugs that would otherwise surface as silently wrong signals.
 */
function assertCoherent(config: EngineConfig): void {
  const problems: string[] = [];

  const longestMa = Math.max(...config.scanner.maPeriods, config.detectors.trend.slowMaPeriod);
  if (config.scanner.candleLimit <= longestMa) {
    problems.push(`scanner.candleLimit (${config.scanner.candleLimit}) must exceed the longest MA period (${longestMa})`);
  }
  if (!config.scanner.timeframes.includes(config.volatility.atrTimeframe)) {
    problems.push(`volatility.atrTimeframe (${config.volatility.atrTimeframe}) must be one of scanner.timeframes`);
  }
  if (!config.scanner.timeframes.includes(config.detectors.trend.higherTimeframe)) {
    problems.push(`detectors.trend.higherTimeframe must be one of scanner.timeframes`);
  }
  if (!config.scanner.maPeriods.includes(config.detectors.pullback.maPeriod)) {
    problems.push(`detectors.pullback.maPeriod (${config.detectors.pullback.maPeriod}) must be in scanner.maPeriods`);
  }
  if (config.scoring.riskRewardCeiling <= config.scoring.riskRewardFloor) {
    problems.push('scoring.riskRewardCeiling must be greater than scoring.riskRewardFloor');
  }
  if (config.scoring.thresholds.approve <= config.scoring.thresholds.watchlist) {
    problems.push('scoring.thresholds.approve must be greater than scoring.thresholds.watchlist');
  }
  if (config.exposure.maxPerInstrumentPct > config.exposure.maxPerGroupPct) {
    problems.push('exposure.maxPerInstrumentPct cannot exceed exposure.maxPerGroupPct');
  }
  if (config.exposure.maxPerGroupPct > config.exposure.maxPortfolioPct) {
    problems.push('exposure.maxPerGroupPct cannot exceed exposure.maxPortfolioPct');
  }
  if (config.maxLoss.perTradeAbsolute > config.maxLoss.perDayAbsolute) {
    problems.push('maxLoss.perTradeAbsolute cannot exceed maxLoss.perDayAbsolute');
  }
  if (config.volatility.minAtrRatio >= config.volatility.maxAtrRatio) {
    problems.push('volatility.minAtrRatio must be below volatility.maxAtrRatio');
  }
  if (config.detectors.momentum.macdFast >= config.detectors.momentum.macdSlow) {
    problems.push('detectors.momentum.macdFast must be below macdSlow');
  }
  const duplicateSymbols = config.instruments
    .map((i) => i.symbol)
    .filter((s, idx, arr) => arr.indexOf(s) !== idx);
  if (duplicateSymbols.length > 0) {
    problems.push(`duplicate instrument symbols: ${[...new Set(duplicateSymbols)].join(', ')}`);
  }
  // R:R is computed against TP1, so it is the first multiple that has to clear
  // the minimum, not the smallest one in the list.
  const firstTarget = config.planning.targetRMultiples[0] as number;
  if (firstTarget < config.planning.minAcceptableRiskReward) {
    problems.push(
      `planning.targetRMultiples[0] (${firstTarget}) is below minAcceptableRiskReward ` +
        `(${config.planning.minAcceptableRiskReward}), so no plan could ever pass`,
    );
  }

  if (problems.length > 0) {
    throw new Error(`Incoherent engine configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  }
}
