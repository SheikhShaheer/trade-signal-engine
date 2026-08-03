import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import {
  BinanceTestnetClient,
  formatQuantity,
  totalFee,
  type BinanceTestnetOptions,
} from './binance-testnet-client.js';
import {
  type ExecutionProvider,
  type SubmitEntryInput,
  type SubmitEntryResult,
  type ClosePositionInput,
  type CloseResult,
} from './types.js';

export interface BinanceTestnetExecutionDeps {
  config: EngineConfig;
  repositories: Repositories;
  client: BinanceTestnetClient;
  logger?: Logger;
}

/**
 * Routes approved memos to Binance Spot Testnet (long-only).
 */
export class BinanceTestnetExecutionProvider implements ExecutionProvider {
  readonly mode = 'testnet' as const;

  constructor(private readonly deps: BinanceTestnetExecutionDeps) {}

  async submitEntry(input: SubmitEntryInput): Promise<SubmitEntryResult> {
    const { memoId, plan, sizing, instrument, lastPrice } = input;
    const logger = (this.deps.logger ?? silentLogger).child({ component: 'binance-testnet' });

    if (plan.direction === 'short') {
      return { ok: false, reason: 'Binance Spot Testnet supports long positions only' };
    }

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

    const takeProfit = plan.targets[0];
    if (takeProfit === undefined) {
      return { ok: false, reason: 'plan has no take-profit target' };
    }

    const qty = formatQuantity(sizing.quantity, instrument.quantityStep);
    if (Number.parseFloat(qty) <= 0) {
      return { ok: false, reason: 'quantity rounds to zero for testnet lot size' };
    }

    try {
      const order = await this.deps.client.marketBuy(plan.instrument, qty);
      const fillPrice = order.avgPrice > 0 ? order.avgPrice : lastPrice;
      const fee = totalFee(order.fills);
      const notional = fillPrice * order.executedQty;

      const result = await this.deps.repositories.execution.createEntry({
        memoId,
        mode: 'testnet',
        instrument: plan.instrument,
        direction: plan.direction,
        quantity: order.executedQty,
        requestedPrice: lastPrice,
        fillPrice,
        fee,
        correlationGroup: instrument.correlationGroup,
        stopLoss: plan.stopLoss,
        takeProfit,
        notional,
        externalOrderId: order.orderId,
      });

      await this.deps.repositories.execution.logEvent({
        memoId,
        orderId: result.orderId,
        eventType: 'filled',
        detail: `testnet BUY orderId=${order.orderId} @ ${fillPrice}`,
      });

      logger.info('testnet entry filled', {
        instrument: plan.instrument,
        binanceOrderId: order.orderId,
        fillPrice,
        quantity: order.executedQty,
      });

      return {
        ok: true,
        orderId: result.orderId,
        positionId: result.positionId,
        fillPrice,
        quantity: order.executedQty,
        fee,
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.deps.repositories.execution.logEvent({
        memoId,
        eventType: 'rejected',
        detail: message,
      });
      return { ok: false, reason: message };
    }
  }

  async closePosition(input: ClosePositionInput): Promise<CloseResult> {
    const instrument = this.deps.config.instruments.find((i) => i.symbol === input.instrument);
    const step = instrument?.quantityStep ?? 0.00001;
    const qty = formatQuantity(input.quantity, step);

    try {
      const order = await this.deps.client.marketSell(input.instrument, qty);
      const exitPrice = order.avgPrice > 0 ? order.avgPrice : input.exitPrice;
      const fee = totalFee(order.fills);
      const grossPnl = (exitPrice - input.entryPrice) * order.executedQty;
      const realised = grossPnl - fee;

      await this.deps.repositories.execution.createExit({
        positionId: input.positionId,
        orderId: input.orderId,
        memoId: input.memoId,
        exitPrice,
        quantity: order.executedQty,
        fee,
        realisedPnl: realised,
        eventType: input.reason === 'sl_hit' ? 'sl_hit' : input.reason === 'tp_hit' ? 'tp_hit' : 'closed',
        externalOrderId: order.orderId,
      });

      return {
        ok: true,
        positionId: input.positionId,
        fillPrice: exitPrice,
        realisedPnl: realised,
        fee,
        reason: input.reason,
      };
    } catch (error) {
      throw new Error(`testnet close failed: ${(error as Error).message}`);
    }
  }
}

export function createBinanceTestnetClient(options: BinanceTestnetOptions): BinanceTestnetClient {
  return new BinanceTestnetClient(options);
}
