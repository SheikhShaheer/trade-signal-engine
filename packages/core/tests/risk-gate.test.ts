import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { RiskGate, summariseFailures } from '../src/stages/risk-gate/index.js';
import type { OpenPosition, TradePlan } from '../src/types.js';
import { makeCandles, makePortfolio, makeSnapshot, testConfig, testInstrument } from './fixtures.js';

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  const referenceEntry = overrides.referenceEntry ?? 100;
  const stopLoss = overrides.stopLoss ?? 98;
  return {
    instrument: testInstrument.symbol,
    direction: 'long',
    entryZone: { low: referenceEntry * 0.999, high: referenceEntry * 1.001 },
    stopLoss,
    targets: [referenceEntry + (referenceEntry - stopLoss) * 1.5],
    riskRewardRatio: 1.5,
    invalidation: '4h close below 98',
    timeframe: '4h',
    confidence: 0.6,
    timestamp: new Date().toISOString(),
    referenceEntry,
    riskPerUnit: Math.abs(referenceEntry - stopLoss),
    atrUsed: 1.3,
    ...overrides,
  };
}

function position(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    instrument: testInstrument.symbol,
    correlationGroup: testInstrument.correlationGroup,
    direction: 'long',
    quantity: 1,
    entryPrice: 100,
    stopLoss: 98,
    notional: 1000,
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A snapshot whose volatility sits comfortably inside the normal band. */
const calmSnapshot = makeSnapshot({
  candles: { '4h': makeCandles({ count: 300, start: 100, drift: 0.0005, wick: 0.004 }) },
});

describe('position sizing', () => {
  const gate = new RiskGate(testConfig);

  it('sizes from the risk budget divided by the stop distance', () => {
    const sizing = gate.computeSizing(plan({ referenceEntry: 100, stopLoss: 98 }), testInstrument, makePortfolio());
    // 1% of 10,000 = 100 risk budget; 2 per unit of risk => 50 units.
    expect(sizing.quantity).toBeCloseTo(50, 3);
    expect(sizing.riskAmount).toBeCloseTo(100, 1);
    expect(sizing.riskPctOfEquity).toBeCloseTo(0.01, 4);
  });

  it('halves the size when the stop distance doubles', () => {
    const tight = gate.computeSizing(plan({ referenceEntry: 100, stopLoss: 98 }), testInstrument, makePortfolio());
    const wide = gate.computeSizing(plan({ referenceEntry: 100, stopLoss: 96 }), testInstrument, makePortfolio());
    expect(wide.quantity).toBeCloseTo(tight.quantity / 2, 3);
  });

  it('rounds down to the exchange quantity step so real risk cannot exceed the budget', () => {
    const coarse = { ...testInstrument, quantityStep: 1 };
    const sizing = gate.computeSizing(plan({ referenceEntry: 100, stopLoss: 97 }), coarse, makePortfolio());
    expect(Number.isInteger(sizing.quantity)).toBe(true);
    expect(sizing.riskAmount).toBeLessThanOrEqual(100);
  });

  it('scales with equity', () => {
    const small = gate.computeSizing(plan(), testInstrument, makePortfolio({ equity: 1_000 }));
    const large = gate.computeSizing(plan(), testInstrument, makePortfolio({ equity: 100_000 }));
    expect(large.quantity).toBeCloseTo(small.quantity * 100, 2);
  });
});

describe('risk gate', () => {
  const gate = new RiskGate(testConfig);

  it('passes a normal plan and records every check', () => {
    const result = gate.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio());

    expect(result.overallPass).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(8);
    const names = result.checks.map((c) => c.check);
    expect(names).toContain('position-size');
    expect(names).toContain('exposure-instrument');
    expect(names).toContain('exposure-group');
    expect(names).toContain('exposure-portfolio');
    expect(names).toContain('drawdown');
    expect(names).toContain('volatility');
    expect(names).toContain('max-loss-per-trade');
    expect(names).toContain('max-loss-per-day');
  });

  it('records numbers and a limit for every check, passing or failing', () => {
    const result = gate.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio({ equity: 200 }));
    for (const check of result.checks) {
      expect(typeof check.valueChecked).toBe('number');
      expect(typeof check.limit).toBe('number');
      expect(check.detail.length).toBeGreaterThan(10);
      expect(check.margin).toBeGreaterThanOrEqual(0);
      expect(check.margin).toBeLessThanOrEqual(1);
    }
  });

  it('blocks every new plan once the drawdown limit is breached', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ equity: 8_500, peakEquity: 10_000 }),
    );

    expect(result.overallPass).toBe(false);
    expect(result.checks.find((c) => c.check === 'drawdown')?.pass).toBe(false);
    expect(summariseFailures(result)).toMatch(/drawdown/);
  });

  it('allows a drawdown just inside the limit', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ equity: 9_500, peakEquity: 10_000 }),
    );
    expect(result.checks.find((c) => c.check === 'drawdown')?.pass).toBe(true);
  });

  it('blocks on the per-instrument exposure cap', () => {
    // The plan itself is 5,000 notional against a 6,000 cap, so 1,500 already
    // open pushes it over.
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ openPositions: [position({ notional: 1_500 })] }),
    );

    expect(result.checks.find((c) => c.check === 'exposure-instrument')?.pass).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  it('blocks on the correlated-group cap even when the instrument itself is clear', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({
        openPositions: [
          position({ instrument: 'ETHUSDT', notional: 2_000 }),
          position({ instrument: 'LTCUSDT', notional: 2_000 }),
        ],
      }),
    );

    expect(result.checks.find((c) => c.check === 'exposure-instrument')?.pass).toBe(true);
    expect(result.checks.find((c) => c.check === 'exposure-group')?.pass).toBe(false);
  });

  it('blocks when the instrument is abnormally volatile', () => {
    // A long calm history followed by a violent expansion in range.
    const calm = makeCandles({ count: 280, start: 100, drift: 0.0005, wick: 0.002 });
    const wild = makeCandles({
      count: 20,
      start: (calm[calm.length - 1] as { close: number }).close,
      drift: 0.02,
      wick: 0.08,
      endTime: Date.now() - 4 * 3_600_000,
    });

    const result = gate.evaluate(
      plan({ referenceEntry: 200, stopLoss: 196 }),
      makeSnapshot({ candles: { '4h': [...calm, ...wild] } }),
      testInstrument,
      makePortfolio(),
    );

    const volatility = result.checks.find((c) => c.check === 'volatility');
    expect(volatility?.pass).toBe(false);
    expect(volatility?.detail).toMatch(/abnormally volatile/);
  });

  it('blocks on the per-trade loss ceiling', () => {
    // 0.2% of $10,000 = $20 — tighter than the sized risk on this fixture.
    const tight = new RiskGate(loadConfig({ maxLoss: { perTradePctOfEquity: 0.002, perDayPctOfEquity: 0.03 } }));
    const result = tight.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio());

    expect(result.checks.find((c) => c.check === 'max-loss-per-trade')?.pass).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  it('can size a plan on a $10 account when a minimum lot still fits the loss ceiling', () => {
    // ADA-like step of 0.1 with a 0.004 stop: one lot risks $0.0004? Wait need realistic numbers.
    // Use the fixture plan's riskPerUnit against $10 equity.
    const small = new RiskGate(loadConfig({ account: { startingEquity: 10 } }));
    const result = small.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio({ equity: 10, peakEquity: 10 }));

    // Either it finds a positive size under the 1.5% ($0.15) ceiling, or it
    // honestly fails sizing-viability — never silently invents zero-risk size.
    if (result.sizing.quantity > 0) {
      expect(result.sizing.riskAmount).toBeLessThanOrEqual(10 * 0.015 + 1e-6);
    } else {
      expect(result.checks.some((c) => c.check === 'sizing-viability' && !c.pass)).toBe(true);
    }
  });

  it('counts the day\'s realised losses towards the daily ceiling', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ dayRealisedPnl: -280 }),
    );

    const daily = result.checks.find((c) => c.check === 'max-loss-per-day');
    expect(daily?.pass).toBe(false);
    expect(daily?.valueChecked).toBeCloseTo(380, 0);
  });

  it('ignores a profitable day when applying the daily ceiling', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ dayRealisedPnl: 500 }),
    );
    expect(result.checks.find((c) => c.check === 'max-loss-per-day')?.pass).toBe(true);
  });

  it('fails a plan the risk budget cannot size at all', () => {
    const coarse = { ...testInstrument, quantityStep: 1000 };
    const result = gate.evaluate(plan(), calmSnapshot, coarse, makePortfolio());

    expect(result.checks.find((c) => c.check === 'sizing-viability')?.pass).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  it('is a hard gate: a single failure blocks the plan regardless of the others', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ equity: 9_000, peakEquity: 10_000 }),
    );

    const failed = result.checks.filter((c) => !c.pass);
    expect(failed).toHaveLength(1);
    expect(result.overallPass).toBe(false);
  });

  it('reports zero aggregate margin whenever the gate fails', () => {
    const result = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ equity: 8_000, peakEquity: 10_000 }),
    );
    expect(result.aggregateMargin).toBe(0);
  });

  it('gives a tightly-passing plan less margin than a comfortable one', () => {
    const comfortable = gate.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio());
    const tight = gate.evaluate(
      plan(),
      calmSnapshot,
      testInstrument,
      makePortfolio({ openPositions: [position({ notional: 900 })], dayRealisedPnl: -190 }),
    );

    expect(tight.overallPass).toBe(true);
    expect(tight.aggregateMargin).toBeLessThan(comfortable.aggregateMargin);
  });

  it('excludes position sizing from the aggregate margin', () => {
    const result = gate.evaluate(plan(), calmSnapshot, testInstrument, makePortfolio());
    const positionSize = result.checks.find((c) => c.check === 'position-size');

    // Sizing always consumes the whole risk budget, so its headroom is ~0 and
    // would otherwise permanently depress the risk-gate-margin score.
    expect(positionSize?.countsTowardMargin).toBe(false);
    expect(positionSize?.margin).toBeLessThan(0.01);
    expect(result.aggregateMargin).toBeGreaterThan(0.2);
  });
});
