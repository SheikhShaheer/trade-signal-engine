import type { EngineConfig, Timeframe } from './schema.js';

/** Apply the operator-selected signal timeframe for one pipeline run. */
export function withSignalTimeframe(config: EngineConfig, timeframe: Timeframe): EngineConfig {
  if (!config.scanner.timeframes.includes(timeframe)) {
    throw new Error(`signal timeframe ${timeframe} must be one of scanner.timeframes`);
  }
  return {
    ...config,
    volatility: { ...config.volatility, atrTimeframe: timeframe },
  };
}
