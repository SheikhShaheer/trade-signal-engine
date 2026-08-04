import type { EngineConfig, InstrumentConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import type { MarketDataProvider } from '../providers/types.js';
import type { OpenPosition } from '../types.js';
import type { ExecutionProvider } from './types.js';
import { isStopHit, isTakeProfitHit, unrealisedPnl } from './types.js';

export interface PositionMonitorDeps {
  config: EngineConfig;
  repositories: Repositories;
  marketData: MarketDataProvider;
  executor: ExecutionProvider;
  logger?: Logger;
}

export interface MonitorResult {
  closed: number;
  marked: number;
  errors: string[];
}

/**
 * Checks open bot positions each pipeline tick, marks unrealised P/L, and closes on stop or first target.
 */
export class PositionMonitor {
  private readonly logger: Logger;

  constructor(private readonly deps: PositionMonitorDeps) {
    this.logger = (deps.logger ?? silentLogger).child({ component: 'position-monitor' });
  }

  async run(): Promise<MonitorResult> {
    const positions = await this.deps.repositories.portfolio.openBotPositions();
    const result: MonitorResult = { closed: 0, marked: 0, errors: [] };

    for (const position of positions) {
      try {
        const outcome = await this.processPosition(position);
        if (outcome === 'closed') result.closed += 1;
        else if (outcome === 'marked') result.marked += 1;
      } catch (error) {
        const message = (error as Error).message;
        result.errors.push(`${position.instrument}: ${message}`);
        this.logger.error('position check failed', { instrument: position.instrument, error: message });
      }
    }

    return result;
  }

  private async processPosition(position: OpenPosition): Promise<'closed' | 'marked' | 'skipped'> {
    if (position.id === undefined) return 'skipped';

    const price = await this.deps.marketData.getLastPrice(position.instrument);
    const takeProfit = position.takeProfit;

    let reason: 'sl_hit' | 'tp_hit' | undefined;
    if (isStopHit(position.direction, price, position.stopLoss)) {
      reason = 'sl_hit';
    } else if (takeProfit !== undefined && isTakeProfitHit(position.direction, price, takeProfit)) {
      reason = 'tp_hit';
    }

    if (reason) {
      await this.deps.executor.closePosition({
        positionId: position.id,
        instrument: position.instrument,
        direction: position.direction,
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        exitPrice: price,
        orderId: position.orderId,
        memoId: position.memoId,
        reason,
      });

      this.logger.info('position closed', {
        instrument: position.instrument,
        direction: position.direction,
        reason,
        price,
      });
      return 'closed';
    }

    const pnl = unrealisedPnl(position.direction, position.entryPrice, price, position.quantity);
    await this.deps.repositories.portfolio.updatePositionMark(position.id, price, pnl);
    return 'marked';
  }
}
