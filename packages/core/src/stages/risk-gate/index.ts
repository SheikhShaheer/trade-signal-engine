import type { EngineConfig, InstrumentConfig } from '../../config/schema.js';
import { roundDownToStep, roundTo } from '../../indicators/index.js';
import type {
  MarketSnapshot,
  PortfolioState,
  PositionSizing,
  RiskCheckResult,
  RiskGateResult,
  TradePlan,
} from '../../types.js';
import {
  drawdownCheck,
  exposureChecks,
  maxLossChecks,
  positionSizeCheck,
  volatilityCheck,
  type CheckContext,
} from './checks.js';

export * from './checks.js';

/**
 * Stage 4. A strict gate: any failed check blocks the plan, full stop. There is
 * no weighting, no override and no "mostly passed" path.
 *
 * Every check's numbers are recorded whether the plan passes or not — the audit
 * trail for a blocked plan is more useful than the one for a passing plan.
 */
export class RiskGate {
  constructor(private readonly config: EngineConfig) {}

  evaluate(
    plan: TradePlan,
    snapshot: MarketSnapshot,
    instrument: InstrumentConfig,
    portfolio: PortfolioState,
  ): RiskGateResult {
    const sizing = this.computeSizing(plan, instrument, portfolio);
    const ctx: CheckContext = { config: this.config, plan, snapshot, instrument, portfolio, sizing };

    const checks: RiskCheckResult[] = [
      positionSizeCheck(ctx),
      ...exposureChecks(ctx),
      drawdownCheck(ctx),
      volatilityCheck(ctx),
      ...maxLossChecks(ctx),
    ];

    // A zero-size plan cannot be acted on, so it is a failure rather than a
    // technically-passing plan with nothing behind it.
    if (sizing.quantity <= 0) {
      checks.unshift({
        check: 'sizing-viability',
        pass: false,
        valueChecked: sizing.quantity,
        limit: instrument.quantityStep,
        margin: 0,
        countsTowardMargin: false,
        detail:
          `risk budget of ${(portfolio.equity * this.config.account.riskPerTradePct).toFixed(2)} ` +
          `${this.config.account.currency} does not buy even one ${instrument.quantityStep} step at a ` +
          `${plan.riskPerUnit} stop distance`,
      });
    }

    const overallPass = checks.every((check) => check.pass);
    const marginRelevant = checks.filter((check) => check.countsTowardMargin);
    const aggregateMargin =
      overallPass && marginRelevant.length > 0
        ? roundTo(marginRelevant.reduce((acc, c) => acc + c.margin, 0) / marginRelevant.length, 4)
        : 0;

    return { overallPass, checks, sizing, aggregateMargin };
  }

  /**
   * Size from risk, not from a fixed notional: quantity is the risk budget
   * divided by the per-unit stop distance, rounded down to the exchange's
   * quantity step so the real risk can only be lower than budgeted.
   *
   * Tiny accounts are special: a $10 account risking 1% ($0.10) often cannot
   * buy even one BTC/ETH step at a normal stop. When the risk budget is
   * positive but rounds to zero, we try one minimum lot — but only if that
   * lot's stop risk still fits under the per-trade max-loss ceiling. That
   * keeps $10 accounts productive without letting them take unbounded risk.
   */
  computeSizing(plan: TradePlan, instrument: InstrumentConfig, portfolio: PortfolioState): PositionSizing {
    const riskBudget = portfolio.equity * this.config.account.riskPerTradePct;
    const rawQuantity = plan.riskPerUnit > 0 ? riskBudget / plan.riskPerUnit : 0;
    let quantity = roundDownToStep(Math.max(0, rawQuantity), instrument.quantityStep);

    if (quantity <= 0 && rawQuantity > 0 && plan.riskPerUnit > 0) {
      const minLot = instrument.quantityStep;
      const minLotRisk = minLot * plan.riskPerUnit;
      const perTradeCap = portfolio.equity * this.config.maxLoss.perTradePctOfEquity;
      if (minLotRisk <= perTradeCap + 1e-9) {
        quantity = minLot;
      }
    }

    const notional = quantity * plan.referenceEntry;
    const riskAmount = quantity * plan.riskPerUnit;

    return {
      quantity,
      notional: roundTo(notional, 2),
      riskAmount: roundTo(riskAmount, 2),
      riskPctOfEquity: portfolio.equity > 0 ? riskAmount / portfolio.equity : 0,
    };
  }
}

/** Human-readable summary of why a plan was blocked. */
export function summariseFailures(result: RiskGateResult): string {
  const failed = result.checks.filter((c) => !c.pass);
  if (failed.length === 0) return 'all risk checks passed';
  return failed.map((c) => `${c.check}: ${c.detail}`).join('; ');
}
