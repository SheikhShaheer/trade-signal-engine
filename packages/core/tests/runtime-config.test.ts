import { describe, expect, it } from 'vitest';
import { loadConfig, withSignalTimeframe } from '../src/config/index.js';

describe('withSignalTimeframe', () => {
  it('overrides atrTimeframe for pipeline runs', () => {
    const config = loadConfig();
    const updated = withSignalTimeframe(config, '1h');
    expect(updated.volatility.atrTimeframe).toBe('1h');
    expect(config.volatility.atrTimeframe).toBe('4h');
  });

  it('rejects timeframes outside scanner.timeframes', () => {
    const config = loadConfig();
    expect(() => withSignalTimeframe(config, '5m' as never)).toThrow();
  });
});
