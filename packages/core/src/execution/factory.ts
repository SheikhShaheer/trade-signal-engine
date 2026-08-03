import type { Repositories } from '../db/repositories.js';
import type { ExecutionMode } from '../types.js';
import {
  BinanceTestnetExecutionProvider,
  type BinanceTestnetExecutionDeps,
} from './binance-testnet.js';
import { PaperExecutionProvider, type PaperExecutionDeps } from './paper.js';
import type { ClosePositionInput, CloseResult, ExecutionProvider, SubmitEntryInput, SubmitEntryResult } from './types.js';

/**
 * Picks paper or testnet execution based on bot_runtime.execution_mode.
 */
export class RoutingExecutionProvider implements ExecutionProvider {
  readonly mode: ExecutionMode;

  constructor(
    private readonly deps: {
      repositories: Repositories;
      paper: PaperExecutionProvider;
      testnet?: BinanceTestnetExecutionProvider;
      defaultMode: ExecutionMode;
    },
  ) {
    this.mode = deps.defaultMode;
  }

  private async activeMode(): Promise<'paper' | 'testnet'> {
    const mode = await this.deps.repositories.bot.executionMode();
    if (mode === 'testnet') {
      if (!this.deps.testnet) {
        throw new Error('testnet mode selected but BINANCE_TESTNET_API_KEY/SECRET are not configured');
      }
      return 'testnet';
    }
    return 'paper';
  }

  async submitEntry(input: SubmitEntryInput): Promise<SubmitEntryResult> {
    const mode = await this.activeMode();
    if (mode === 'testnet' && this.deps.testnet) {
      return this.deps.testnet.submitEntry(input);
    }
    return this.deps.paper.submitEntry(input);
  }

  async closePosition(input: ClosePositionInput): Promise<CloseResult> {
    const mode = await this.activeMode();
    if (mode === 'testnet' && this.deps.testnet) {
      return this.deps.testnet.closePosition(input);
    }
    return this.deps.paper.closePosition(input);
  }
}

export function createExecutionProvider(deps: PaperExecutionDeps & Partial<BinanceTestnetExecutionDeps>): ExecutionProvider {
  const paper = new PaperExecutionProvider(deps);
  let testnet: BinanceTestnetExecutionProvider | undefined;
  if (deps.client) {
    testnet = new BinanceTestnetExecutionProvider({
      config: deps.config,
      repositories: deps.repositories,
      client: deps.client,
      logger: deps.logger,
    });
  }

  if (deps.config.execution.mode === 'live') {
    throw new Error('live execution is not implemented');
  }

  return new RoutingExecutionProvider({
    repositories: deps.repositories,
    paper,
    testnet,
    defaultMode: deps.config.execution.mode,
  });
}
