import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

describe('config', () => {
  it('loads the defaults agreed with the operator', () => {
    const config = loadConfig();
    expect(config.account.startingEquity).toBe(10_000);
    expect(config.account.riskPerTradePct).toBe(0.01);
    expect(config.account.maxDrawdownPct).toBe(0.1);
    expect(config.instruments.length).toBeGreaterThan(0);
  });

  it('keeps the scoring weights summing to exactly 1', () => {
    const weights = loadConfig().scoring.weights;
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('matches the rubric weights from the specification', () => {
    const weights = loadConfig().scoring.weights;
    expect(weights.signalStrength).toBe(0.3);
    expect(weights.trendAlignment).toBe(0.2);
    expect(weights.riskRewardQuality).toBe(0.2);
    expect(weights.riskGateMargin).toBe(0.15);
    expect(weights.newsConfirmation).toBe(0.15);
  });

  it('rejects weights that do not sum to 1', () => {
    expect(() =>
      loadConfig({ scoring: { weights: { signalStrength: 0.5, trendAlignment: 0.5, riskRewardQuality: 0.5, riskGateMargin: 0.5, newsConfirmation: 0.5 } } }),
    ).toThrow(/sum to exactly 1/);
  });

  it('rejects a candle limit that cannot support the longest moving average', () => {
    expect(() => loadConfig({ scanner: { candleLimit: 50 } })).toThrow(/candleLimit/);
  });

  it('rejects an approval threshold at or below the watchlist threshold', () => {
    expect(() => loadConfig({ scoring: { thresholds: { approve: 5, watchlist: 5 } } })).toThrow(
      /approve must be greater/,
    );
  });

  it('rejects exposure caps that are internally inconsistent', () => {
    expect(() => loadConfig({ exposure: { maxPerInstrumentPct: 0.9, maxPerGroupPct: 0.4 } })).toThrow(
      /maxPerInstrumentPct cannot exceed/,
    );
  });

  it('rejects a per-trade loss ceiling above the per-day ceiling', () => {
    expect(() => loadConfig({ maxLoss: { perTradeAbsolute: 500, perDayAbsolute: 300 } })).toThrow(
      /perTradeAbsolute cannot exceed/,
    );
  });

  it('rejects a first target that could never clear the minimum R:R', () => {
    expect(() =>
      loadConfig({ planning: { targetRMultiples: [0.5], minAcceptableRiskReward: 1.5 } }),
    ).toThrow(/below minAcceptableRiskReward/);
  });

  it('accepts later targets below the minimum, since R:R is measured at TP1', () => {
    expect(() =>
      loadConfig({ planning: { targetRMultiples: [2, 1.2], minAcceptableRiskReward: 1.5 } }),
    ).not.toThrow();
  });

  it('rejects duplicate instrument symbols', () => {
    expect(() =>
      loadConfig({
        instruments: [
          { symbol: 'BTCUSDT', label: 'a', correlationGroup: 'g', quantityStep: 0.001, priceDecimals: 2 },
          { symbol: 'BTCUSDT', label: 'b', correlationGroup: 'g', quantityStep: 0.001, priceDecimals: 2 },
        ],
      }),
    ).toThrow(/duplicate instrument symbols/);
  });

  it('rejects a volatility timeframe the scanner does not collect', () => {
    expect(() => loadConfig({ volatility: { atrTimeframe: '15m' }, scanner: { timeframes: ['1h', '4h', '1d'] } })).toThrow(
      /atrTimeframe/,
    );
  });
});
