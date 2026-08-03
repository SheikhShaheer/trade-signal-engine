import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import {
  applySlippage,
  clampToEntryZone,
  computeFee,
  type ExecutionProvider,
  type SubmitEntryInput,
  type SubmitEntryResult,
  type ClosePositionInput,
  type CloseResult,
} from './types.js';

export interface PaperExecutionDeps {
  config: EngineConfig;
  repositories: Repositories;
  logger?: Logger;
}

/**
 * Simulated broker: fills entries at market with slippage/fees and persists
 * orders, fills, and open positions atomically.
 */
export class PaperExecutionProvider implements ExecutionProvider {
  readonly mode = 'paper' as const;

  constructor(private readonly deps: PaperExecutionDeps) {}

  async submitEntry(input: SubmitEntryInput): Promise<SubmitEntryResult> {
    const { memo, memoId, plan, sizing, instrument, lastPrice } = input;
    const { slippageBps, feeBps } = this.deps.config.execution;

    if (sizing.quantity <= 0) {
      return { ok: false, reason: 'position size rounds to zero' };
    }

    const portfolio = await this.deps.repositories.portfolio.current(
      this.deps.config.account.startingEquity,
    );
    const duplicate = portfolio.openPositions.some(
      (p) => p.instrument === plan.instrument && p.direction === plan.direction,
    );
    if (duplicate) {
      await this.deps.repositories.execution.logEvent({
        memoId,
        eventType: 'skipped',
        detail: `open ${plan.direction} on ${plan.instrument} already exists`,
      });
      return { ok: false, reason: `duplicate open position on ${plan.instrument}` };
    }

    const zonePrice = clampToEntryZone(lastPrice, plan.entryZone.low, plan.entryZone.high);
    const fillPrice = applySlippage(zonePrice, plan.direction, slippageBps);
    const notional = fillPrice * sizing.quantity;
    const fee = computeFee(notional, feeBps);
    const takeProfit = plan.targets[0];

    if (takeProfit === undefined) {
      return { ok: false, reason: 'plan has no take-profit target' };
    }

    const result = await this.deps.repositories.execution.createEntry({
      memoId,
      mode: 'paper',
      instrument: plan.instrument,
      direction: plan.direction,
      quantity: sizing.quantity,
      requestedPrice: lastPrice,
      fillPrice,
      fee,
      correlationGroup: instrument.correlationGroup,
      stopLoss: plan.stopLoss,
      takeProfit,
      notional,
    });

    return {
      ok: true,
      orderId: result.orderId,
      positionId: result.positionId,
      fillPrice,
      quantity: sizing.quantity,
      fee,
    };
  }

  async closePosition(input: ClosePositionInput): Promise<CloseResult> {
    const { slippageBps, feeBps } = this.deps.config.execution;
    const exitPrice = applySlippage(input.exitPrice, input.direction === 'long' ? 'short' : 'long', slippageBps);
    const notional = exitPrice * input.quantity;
    const fee = computeFee(notional, feeBps);
    const grossPnl =
      input.direction === 'long'
        ? (exitPrice - input.entryPrice) * input.quantity
        : (input.entryPrice - exitPrice) * input.quantity;
    const realised = grossPnl - fee;

    await this.deps.repositories.execution.createExit({
      positionId: input.positionId,
      orderId: input.orderId,
      memoId: input.memoId,
      exitPrice,
      quantity: input.quantity,
      fee,
      realisedPnl: realised,
      eventType: input.reason === 'sl_hit' ? 'sl_hit' : input.reason === 'tp_hit' ? 'tp_hit' : 'closed',
    });

    return {
      ok: true,
      positionId: input.positionId,
      fillPrice: exitPrice,
      realisedPnl: realised,
      fee,
      reason: input.reason,
    };
  }
}
