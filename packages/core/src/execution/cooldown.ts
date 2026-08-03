import type { Repositories } from '../db/repositories.js';
import type { Direction, ExecutionEventType } from '../types.js';

export interface CooldownCheckInput {
  instrument: string;
  direction: Direction;
  duplicateCooldownMinutes: number;
}

/**
 * Returns true when a recent human dismissal or bot trade on the same idea
 * should block a new entry.
 */
export async function shouldSkipExecution(
  repositories: Repositories,
  input: CooldownCheckInput,
): Promise<{ skip: boolean; reason?: string }> {
  const { instrument, direction, duplicateCooldownMinutes } = input;

  const recentDismissal = await repositories.review.recentHumanDismissal(
    instrument,
    direction,
    duplicateCooldownMinutes,
  );
  if (recentDismissal) {
    return { skip: true, reason: 'human dismissed this idea recently' };
  }

  const recentTrade = await repositories.execution.recentTradeOnIdea(
    instrument,
    direction,
    duplicateCooldownMinutes,
  );
  if (recentTrade) {
    return { skip: true, reason: 'bot traded this idea recently' };
  }

  return { skip: false };
}
