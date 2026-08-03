import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import { loadConfig } from '../src/config/index.js';
import {
  applySlippage,
  clampToEntryZone,
  computeFee,
  isStopHit,
  isTakeProfitHit,
  PaperExecutionProvider,
} from '../src/execution/index.js';
import { makeFakeRepositories } from './fake-repos.js';

describe('execution exports', () => {
  it('exports paper execution types and provider', () => {
    expect(core.PaperExecutionProvider).toBeDefined();
    expect(core.createExecutionProvider).toBeDefined();
    expect(core.PositionMonitor).toBeDefined();
  });
});

describe('paper fill math', () => {
  it('clamps entry price to the zone', () => {
    expect(clampToEntryZone(105, 100, 102)).toBe(102);
    expect(clampToEntryZone(99, 100, 102)).toBe(100);
    expect(clampToEntryZone(101, 100, 102)).toBe(101);
  });

  it('applies slippage against the trader', () => {
    expect(applySlippage(100, 'long', 10)).toBeGreaterThan(100);
    expect(applySlippage(100, 'short', 10)).toBeLessThan(100);
  });

  it('computes fees from notional', () => {
    expect(computeFee(1000, 10)).toBeCloseTo(1);
  });

  it('detects stop and take-profit hits', () => {
    expect(isStopHit('long', 99, 100)).toBe(true);
    expect(isStopHit('long', 101, 100)).toBe(false);
    expect(isTakeProfitHit('long', 110, 109)).toBe(true);
    expect(isTakeProfitHit('short', 90, 91)).toBe(true);
  });
});

describe('PaperExecutionProvider', () => {
  it('opens a position for a valid entry', async () => {
    const config = loadConfig();
    const { repositories, state } = makeFakeRepositories();
    const executor = new PaperExecutionProvider({ config, repositories });

    const result = await executor.submitEntry({
      memoId: 1,
      memo: {
        instrument: 'BTCUSDT',
        direction: 'long',
        score: 8,
        decision: 'approved',
        tradePlan: {
          instrument: 'BTCUSDT',
          direction: 'long',
          entryZone: { low: 99, high: 101 },
          stopLoss: 95,
          targets: [110],
          riskRewardRatio: 2,
          invalidation: 'below 95',
          timeframe: '4h',
          confidence: 0.8,
          timestamp: new Date().toISOString(),
          referenceEntry: 100,
          riskPerUnit: 5,
          atrUsed: 2,
        },
        signalsFired: [],
        riskGateResult: {
          overallPass: true,
          checks: [],
          sizing: { quantity: 0.01, notional: 1000, riskAmount: 50, riskPctOfEquity: 0.01 },
          aggregateMargin: 0.8,
        },
        scoreBreakdown: [],
        rationale: 'test',
        timestamp: new Date().toISOString(),
      },
      plan: {
        instrument: 'BTCUSDT',
        direction: 'long',
        entryZone: { low: 99, high: 101 },
        stopLoss: 95,
        targets: [110],
        riskRewardRatio: 2,
        invalidation: 'below 95',
        timeframe: '4h',
        confidence: 0.8,
        timestamp: new Date().toISOString(),
        referenceEntry: 100,
        riskPerUnit: 5,
        atrUsed: 2,
      },
      sizing: { quantity: 0.01, notional: 1000, riskAmount: 50, riskPctOfEquity: 0.01 },
      instrument: config.instruments[0]!,
      lastPrice: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(state.positions.filter((p) => !p.closed)).toHaveLength(1);
      expect(result.fillPrice).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate open positions', async () => {
    const config = loadConfig();
    const { repositories, state } = makeFakeRepositories();
    state.positions.push({
      id: 1,
      instrument: 'BTCUSDT',
      direction: 'long',
      quantity: 0.01,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 110,
      closed: false,
    });
    const executor = new PaperExecutionProvider({ config, repositories });
    const input = {
      memoId: 2,
      memo: {} as never,
      plan: {
        instrument: 'BTCUSDT',
        direction: 'long' as const,
        entryZone: { low: 99, high: 101 },
        stopLoss: 95,
        targets: [110],
        riskRewardRatio: 2,
        invalidation: '',
        timeframe: '4h' as const,
        confidence: 0.8,
        timestamp: new Date().toISOString(),
        referenceEntry: 100,
        riskPerUnit: 5,
        atrUsed: 2,
      },
      sizing: { quantity: 0.01, notional: 1000, riskAmount: 50, riskPctOfEquity: 0.01 },
      instrument: config.instruments[0]!,
      lastPrice: 100,
    };
    const result = await executor.submitEntry(input);
    expect(result.ok).toBe(false);
  });
});

describe('default config', () => {
  it('enables paper execution for approved memos', () => {
    const config = loadConfig();
    expect(config.execution.mode).toBe('paper');
    expect(config.execution.autoDecisions).toContain('approved');
    expect(config.execution.paused).toBe(false);
  });
});
