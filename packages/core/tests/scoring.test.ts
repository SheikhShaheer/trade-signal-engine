import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { DecisionScorer } from '../src/stages/scoring.js';
import type {
  DetectorResult,
  RiskGateResult,
  SignalCandidate,
  TradePlan,
} from '../src/types.js';
import { makeCandles, makeSnapshot, testConfig, testInstrument } from './fixtures.js';

function detector(overrides: Partial<DetectorResult> = {}): DetectorResult {
  return {
    name: 'breakout',
    triggered: true,
    strength: 0.7,
    rationale: 'test',
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

function plan(overrides: Partial<TradePlan> = {}): TradePlan {
  return {
    instrument: testInstrument.symbol,
    direction: 'long',
    entryZone: { low: 99.5, high: 100.5 },
    stopLoss: 98,
    targets: [103, 105, 108],
    riskRewardRatio: 1.5,
    invalidation: '4h close below 98',
    timeframe: '4h',
    confidence: 0.7,
    timestamp: new Date().toISOString(),
    referenceEntry: 100,
    riskPerUnit: 2,
    atrUsed: 1.3,
    ...overrides,
  };
}

function gateResult(overrides: Partial<RiskGateResult> = {}): RiskGateResult {
  return {
    overallPass: true,
    aggregateMargin: 0.7,
    checks: [
      { check: 'position-size', pass: true, detail: 'ok', valueChecked: 100, limit: 100, margin: 0.7 },
      { check: 'drawdown', pass: true, detail: 'ok', valueChecked: 0, limit: 0.1, margin: 1 },
    ],
    sizing: { quantity: 50, notional: 5_000, riskAmount: 100, riskPctOfEquity: 0.01 },
    ...overrides,
  };
}

const upSnapshot = makeSnapshot({
  candles: {
    '4h': makeCandles({ count: 300, drift: 0.004 }),
    '1d': makeCandles({ count: 300, drift: 0.005, intervalMs: 86_400_000 }),
  },
});

describe('DecisionScorer', () => {
  const scorer = new DecisionScorer(testConfig);

  it('produces a score in 0..10 with one component per rubric row', () => {
    const { score, components } = scorer.score(candidate(), plan(), gateResult(), upSnapshot);

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(10);
    expect(components.map((c) => c.component)).toEqual([
      'signal-strength',
      'trend-alignment',
      'risk-reward',
      'risk-gate-margin',
      'news-confirmation',
    ]);
  });

  it('sums the component contributions to exactly the reported score', () => {
    const { score, components } = scorer.score(candidate(), plan(), gateResult(), upSnapshot);
    const total = components.reduce((acc, c) => acc + c.contribution, 0);
    expect(total).toBeCloseTo(score, 2);
  });

  it('caps each component at its configured weight share of 10 points', () => {
    const { components } = scorer.score(
      candidate({
        triggeredDetectors: [
          detector({ strength: 1 }),
          detector({ name: 'momentum', strength: 1 }),
          detector({ name: 'pullback', strength: 1 }),
        ],
      }),
      plan({ riskRewardRatio: 10 }),
      gateResult({ aggregateMargin: 1 }),
      upSnapshot,
    );

    for (const component of components) {
      expect(component.contribution).toBeLessThanOrEqual(component.weight * 10 + 1e-6);
      expect(component.raw).toBeLessThanOrEqual(1);
    }
  });

  it('scores more independently-agreeing detectors higher', () => {
    const one = scorer.score(candidate(), plan(), gateResult(), upSnapshot);
    const three = scorer.score(
      candidate({
        triggeredDetectors: [detector(), detector({ name: 'momentum' }), detector({ name: 'pullback' })],
      }),
      plan(),
      gateResult(),
      upSnapshot,
    );
    expect(three.score).toBeGreaterThan(one.score);
  });

  it('penalises a counter-trend setup on the trend component', () => {
    const aligned = scorer.score(candidate(), plan(), gateResult(), upSnapshot);
    const against = scorer.score(
      candidate({ counterTrend: true, direction: 'short', triggeredDetectors: [detector({ direction: 'short' })] }),
      plan({ direction: 'short' }),
      gateResult(),
      upSnapshot,
    );

    const alignedTrend = aligned.components.find((c) => c.component === 'trend-alignment');
    const againstTrend = against.components.find((c) => c.component === 'trend-alignment');
    expect(againstTrend?.raw).toBeLessThan(alignedTrend?.raw as number);
  });

  it('treats a flat higher timeframe as neutral rather than a penalty', () => {
    const flat = makeSnapshot({
      candles: { '4h': makeCandles({ count: 300, drift: 0 }), '1d': makeCandles({ count: 300, drift: 0, intervalMs: 86_400_000 }) },
    });
    const { components } = scorer.score(candidate(), plan(), gateResult(), flat);
    expect(components.find((c) => c.component === 'trend-alignment')?.raw).toBe(0.5);
  });

  it('scores a better computed R:R higher', () => {
    const low = scorer.score(candidate(), plan({ riskRewardRatio: 1.2 }), gateResult(), upSnapshot);
    const high = scorer.score(candidate(), plan({ riskRewardRatio: 3.5 }), gateResult(), upSnapshot);
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('scores a tightly-passing risk gate below a comfortable one', () => {
    const tight = scorer.score(candidate(), plan(), gateResult({ aggregateMargin: 0.02 }), upSnapshot);
    const roomy = scorer.score(candidate(), plan(), gateResult({ aggregateMargin: 0.95 }), upSnapshot);
    expect(roomy.score).toBeGreaterThan(tight.score);
  });

  it('treats absent news as neutral, not as evidence against the setup', () => {
    const { components } = scorer.score(candidate(), plan(), gateResult(), upSnapshot);
    const news = components.find((c) => c.component === 'news-confirmation');
    expect(news?.raw).toBe(0.5);
    expect(news?.basis).toMatch(/neutral/);
  });

  it('rewards news that supports the direction and penalises news that contradicts it', () => {
    const withNews = (sentiment: number) =>
      makeSnapshot({
        candles: { '4h': makeCandles({ count: 300, drift: 0.004 }), '1d': makeCandles({ count: 300, drift: 0.005, intervalMs: 86_400_000 }) },
        news: {
          items: [
            {
              id: '1',
              headline: 'test',
              source: 'test',
              url: undefined,
              publishedAt: new Date().toISOString(),
              sentiment,
            },
          ],
          aggregateSentiment: sentiment,
          itemCount: 1,
          provider: 'test',
        },
      });

    const supportive = scorer.score(candidate(), plan(), gateResult(), withNews(0.8));
    const contradictory = scorer.score(candidate(), plan(), gateResult(), withNews(-0.8));
    expect(supportive.score).toBeGreaterThan(contradictory.score);
  });

  it('flips the sign of news agreement for a short', () => {
    const bullishNews = makeSnapshot({
      candles: { '4h': makeCandles({ count: 300, drift: 0.004 }) },
      news: { aggregateSentiment: 0.8, itemCount: 2, provider: 'test', items: [] },
    });

    const short = scorer.score(
      candidate({ direction: 'short', triggeredDetectors: [detector({ direction: 'short' })] }),
      plan({ direction: 'short' }),
      gateResult(),
      bullishNews,
    );
    const news = short.components.find((c) => c.component === 'news-confirmation');
    expect(news?.raw).toBeLessThan(0.5);
    expect(news?.basis).toMatch(/contradicts/);
  });
});

describe('decision thresholds', () => {
  const scorer = new DecisionScorer(testConfig);

  it('approves at or above the approval threshold', () => {
    expect(scorer.decide(7.5, true)).toBe('approved');
    expect(scorer.decide(9.9, true)).toBe('approved');
  });

  it('watchlists between the two thresholds', () => {
    expect(scorer.decide(7.49, true)).toBe('watchlist');
    expect(scorer.decide(5, true)).toBe('watchlist');
  });

  it('rejects below the watchlist threshold', () => {
    expect(scorer.decide(4.99, true)).toBe('rejected');
  });

  it('rejects a failed risk gate no matter how high the score', () => {
    expect(scorer.decide(10, false)).toBe('rejected');
    expect(scorer.decide(7.5, false)).toBe('rejected');
  });

  it('honours reconfigured thresholds instead of hardcoded ones', () => {
    const strict = new DecisionScorer(loadConfig({ scoring: { thresholds: { approve: 9, watchlist: 8 } } }));
    expect(strict.decide(8.5, true)).toBe('watchlist');
    expect(strict.decide(9, true)).toBe('approved');
    expect(strict.decide(7.9, true)).toBe('rejected');
  });

  it('honours runtime approve threshold override from settings', () => {
    scorer.setApproveThreshold(6);
    expect(scorer.decide(6, true)).toBe('approved');
    expect(scorer.decide(5.5, true)).toBe('watchlist');
    expect(scorer.effectiveApproveThreshold()).toBe(6);
  });
});

describe('decision memo', () => {
  const scorer = new DecisionScorer(testConfig);

  it('carries the plan, signals, risk checks and breakdown', () => {
    const memo = scorer.buildMemo({
      candidate: candidate(),
      plan: plan(),
      riskGate: gateResult(),
      snapshot: upSnapshot,
    });

    expect(memo.tradePlan).toBeDefined();
    expect(memo.signalsFired.length).toBeGreaterThan(0);
    expect(memo.riskGateResult.checks.length).toBeGreaterThan(0);
    expect(memo.scoreBreakdown).toHaveLength(5);
    expect(['approved', 'watchlist', 'rejected']).toContain(memo.decision);
  });

  it('writes a rationale naming the levels and the decision reason', () => {
    const memo = scorer.buildMemo({
      candidate: candidate(),
      plan: plan(),
      riskGate: gateResult(),
      snapshot: upSnapshot,
    });

    expect(memo.rationale).toContain('BTCUSDT');
    expect(memo.rationale).toContain('98');
    expect(memo.rationale).toMatch(/Scored \d/);
    expect(memo.rationale.split('. ').length).toBeGreaterThanOrEqual(3);
  });

  it('explains a risk-gate block in the rationale of a rejected memo', () => {
    const memo = scorer.buildMemo({
      candidate: candidate(),
      plan: plan(),
      riskGate: gateResult({
        overallPass: false,
        aggregateMargin: 0,
        checks: [
          {
            check: 'drawdown',
            pass: false,
            detail: 'account is 12% below peak, past the 10% limit',
            valueChecked: 0.12,
            limit: 0.1,
            margin: 0,
          },
        ],
      }),
      snapshot: upSnapshot,
    });

    expect(memo.decision).toBe('rejected');
    expect(memo.rationale).toMatch(/Risk gate blocked/);
    expect(memo.rationale).toMatch(/overrides the score/);
  });
});
