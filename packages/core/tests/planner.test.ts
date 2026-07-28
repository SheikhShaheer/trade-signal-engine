import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { TradePlanBuilder } from '../src/stages/planner.js';
import type { DetectorResult, SignalCandidate } from '../src/types.js';
import { makeCandles, makeKeyLevel, makeSnapshot, testConfig, testInstrument } from './fixtures.js';

function detector(overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    name: 'breakout',
    triggered: true,
    strength: 0.7,
    rationale: 'test detector',
    direction: 'long',
    evidence: {},
    ...overrides,
  };
}

function candidate(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  const triggered = overrides.triggeredDetectors ?? [detector()];
  return {
    instrument: testInstrument.symbol,
    capturedAt: new Date().toISOString(),
    detectors: triggered,
    triggeredDetectors: triggered,
    direction: 'long',
    agreementCount: triggered.length,
    disagreementCount: 0,
    counterTrend: false,
    ...overrides,
  };
}

describe('TradePlanBuilder', () => {
  const builder = new TradePlanBuilder(testConfig);

  it('builds a long plan with the stop below entry and targets above', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = builder.build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan;

    expect(plan.stopLoss).toBeLessThan(plan.referenceEntry);
    expect(plan.entryZone.low).toBeLessThan(plan.entryZone.high);
    for (const target of plan.targets) expect(target).toBeGreaterThan(plan.referenceEntry);
    expect(plan.targets).toHaveLength(testConfig.planning.targetRMultiples.length);
  });

  it('builds a short plan with the stop above entry and targets below', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, start: 500, drift: -0.004 }) } });
    const result = builder.build(candidate({ direction: 'short' }), snapshot, testInstrument);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.stopLoss).toBeGreaterThan(result.plan.referenceEntry);
    for (const target of result.plan.targets) expect(target).toBeLessThan(result.plan.referenceEntry);
  });

  it('computes risk/reward from the actual levels rather than asserting it', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = builder.build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const plan = result.plan;

    const risk = Math.abs(plan.referenceEntry - plan.stopLoss);
    const reward = Math.abs((plan.targets[0] as number) - plan.referenceEntry);
    expect(plan.riskRewardRatio).toBeCloseTo(reward / risk, 1);
  });

  it('derives the first target from the configured R multiple', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = builder.build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.riskRewardRatio).toBeCloseTo(testConfig.planning.targetRMultiples[0] as number, 1);
  });

  it('produces an invalidation naming a specific price and timeframe', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = builder.build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.invalidation).toMatch(/^4h close (below|above) \d/);
    expect(result.plan.invalidation).toContain(String(result.plan.stopLoss));
  });

  it('rejects a plan whose computed R:R misses the minimum', () => {
    // The config loader refuses this combination precisely because no plan could
    // pass it, so the builder's own guard is exercised with a hand-built config.
    const impossible = {
      ...testConfig,
      planning: { ...testConfig.planning, targetRMultiples: [5], minAcceptableRiskReward: 8 },
    };
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = new TradePlanBuilder(impossible).build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toMatch(/below the 8 minimum/);
  });

  it('is refused by the config loader before such a config can reach the builder', () => {
    expect(() => loadConfig({ planning: { targetRMultiples: [5], minAcceptableRiskReward: 8 } })).toThrow(
      /no plan could ever pass/,
    );
  });

  it('rejects a plan when ATR is unavailable', () => {
    const snapshot = makeSnapshot({ timeframeOverrides: { '4h': { atr: undefined } } });
    const result = builder.build(candidate(), snapshot, testInstrument);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toMatch(/ATR unavailable/);
  });

  it('rejects a plan when a well-tested level blocks the run to TP1', () => {
    const candles = makeCandles({ count: 300, drift: 0.004 });
    const snapshot = makeSnapshot({ candles: { '4h': candles } });
    const price = snapshot.price;

    const blocked = makeSnapshot({
      candles: { '4h': candles },
      keyLevels: [makeKeyLevel({ kind: 'resistance', price: price * 1.001, touches: 5, isTouching: false })],
    });

    const result = builder.build(candidate(), blocked, testInstrument);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.reason).toMatch(/sits between entry/);
  });

  it('tightens the stop to just beyond a nearby support instead of through it', () => {
    const candles = makeCandles({ count: 300, drift: 0.004 });
    const bare = builder.build(candidate(), makeSnapshot({ candles: { '4h': candles } }), testInstrument);
    expect(bare.ok).toBe(true);
    if (!bare.ok) return;

    const atrStop = bare.plan.stopLoss;
    const supportPrice = (atrStop + bare.plan.referenceEntry) / 2;

    const withSupport = builder.build(
      candidate(),
      makeSnapshot({
        candles: { '4h': candles },
        keyLevels: [makeKeyLevel({ kind: 'support', price: supportPrice, touches: 3, isTouching: false })],
      }),
      testInstrument,
    );

    expect(withSupport.ok).toBe(true);
    if (!withSupport.ok) return;
    expect(withSupport.plan.stopLoss).toBeGreaterThan(atrStop);
    expect(withSupport.plan.stopLoss).toBeLessThan(supportPrice);
  });

  it('never widens the stop past the ATR-derived level', () => {
    const candles = makeCandles({ count: 300, drift: 0.004 });
    const snapshot = makeSnapshot({ candles: { '4h': candles } });
    const atr = snapshot.timeframes['4h']?.atr as number;

    const result = builder.build(
      candidate(),
      makeSnapshot({
        candles: { '4h': candles },
        keyLevels: [makeKeyLevel({ kind: 'support', price: snapshot.price - atr * 10, touches: 4, isTouching: false })],
      }),
      testInstrument,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const maxDistance = atr * testConfig.planning.stopAtrMultiple * 1.01;
    expect(result.plan.referenceEntry - result.plan.stopLoss).toBeLessThanOrEqual(maxDistance);
  });

  it('penalises confidence for a counter-trend idea', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const aligned = builder.build(candidate({ counterTrend: false }), snapshot, testInstrument);
    const against = builder.build(candidate({ counterTrend: true }), snapshot, testInstrument);

    expect(aligned.ok && against.ok).toBe(true);
    if (!aligned.ok || !against.ok) return;
    expect(against.plan.confidence).toBeLessThan(aligned.plan.confidence);
  });

  it('raises confidence when more detectors agree', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const one = builder.build(candidate({ agreementCount: 1 }), snapshot, testInstrument);
    const three = builder.build(
      candidate({
        triggeredDetectors: [detector(), detector({ name: 'momentum' }), detector({ name: 'pullback' })],
        agreementCount: 3,
      }),
      snapshot,
      testInstrument,
    );

    expect(one.ok && three.ok).toBe(true);
    if (!one.ok || !three.ok) return;
    expect(three.plan.confidence).toBeGreaterThan(one.plan.confidence);
  });

  it('keeps confidence inside 0..1', () => {
    const snapshot = makeSnapshot({ candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) } });
    const result = builder.build(
      candidate({
        triggeredDetectors: [
          detector({ strength: 1 }),
          detector({ name: 'momentum', strength: 1 }),
          detector({ name: 'pullback', strength: 1 }),
          detector({ name: 'trend', strength: 1 }),
        ],
        agreementCount: 4,
      }),
      snapshot,
      testInstrument,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.confidence).toBeGreaterThanOrEqual(0);
    expect(result.plan.confidence).toBeLessThanOrEqual(1);
  });
});
