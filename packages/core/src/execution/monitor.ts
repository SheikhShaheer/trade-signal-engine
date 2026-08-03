import type { EngineConfig } from '../config/schema.js';
import type { Repositories } from '../db/repositories.js';
import { silentLogger, type Logger } from '../logging/logger.js';
import type { MarketDataProvider } from '../providers/types.js';
import type { OpenPosition } from '../types.js';
import type { ExecutionProvider } from './types.js';
import { isStopHit, isTakeProfitHit } from './types.js';

export interface PositionMonitorDeps {
  config: EngineConfig;
  repositories: Repositories;
  marketData: MarketDataProvider;
  executor: ExecutionProvider;
  logger?: Logger;
}

export interface MonitorResult {
  closed: number;
  errors: string[];
}

/**
 * Checks open bot positions each pipeline tick and closes on stop or first target.
 */
export class PositionMonitor {
  private readonly logger: Logger;

  constructor(private readonly deps: PositionMonitorDeps) {
    this.logger = (deps.logger ?? silentLogger).child({ component: 'position-monitor' });
  }

  async run(): Promise<MonitorResult> {
    const positions = await this.deps.repositories.portfolio.openBotPositions();
    const result: MonitorResult = { closed: 0, errors: [] };

    for (const position of positions) {
      try {
        const closed = await this.checkPosition(position);
        if (closed) result.closed += 1;
      } catch (error) {
        const message = (error as Error).message;
        result.errors.push(`${position.instrument}: ${message}`);
        this.logger.error('position check failed', { instrument: position.instrument, error: message });
      }
    }

    return result;
  }

  private async checkPosition(position: OpenPosition): Promise<boolean> {
    if (position.id === undefined) return false;
    const takeProfit = position.takeProfit;
    if (takeProfit === undefined) return false;

    const price = await this.deps.marketData.getLastPrice(position.instrument);

    let reason: 'sl_hit' | 'tp_hit' | undefined;
    if (isStopHit(position.direction, price, position.stopLoss)) {
      reason = 'sl_hit';
    } else if (isTakeProfitHit(position.direction, price, takeProfit)) {
      reason = 'tp_hit';
    }

    if (!reason) return false;

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
    return true;
  }
}
