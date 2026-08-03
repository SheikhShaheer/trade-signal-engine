import type { InstrumentConfig } from '../config/schema.js';
import type {
  DecisionMemo,
  Direction,
  ExecutionMode,
  PositionSizing,
  TradePlan,
} from '../types.js';

export interface OrderResult {
  ok: true;
  orderId: number;
  positionId: number;
  fillPrice: number;
  quantity: number;
  fee: number;
}

export interface OrderRejection {
  ok: false;
  reason: string;
}

export type SubmitEntryResult = OrderResult | OrderRejection;

export interface CloseResult {
  ok: true;
  positionId: number;
  fillPrice: number;
  realisedPnl: number;
  fee: number;
  reason: 'sl_hit' | 'tp_hit' | 'manual';
}

export interface ExecutionProvider {
  readonly mode: ExecutionMode;
  submitEntry(input: SubmitEntryInput): Promise<SubmitEntryResult>;
  closePosition(input: ClosePositionInput): Promise<CloseResult>;
}

export interface SubmitEntryInput {
  memo: DecisionMemo;
  memoId: number;
  plan: TradePlan;
  sizing: PositionSizing;
  instrument: InstrumentConfig;
  lastPrice: number;
}

export interface ClosePositionInput {
  positionId: number;
  instrument: string;
  direction: Direction;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  orderId?: number;
  memoId?: number;
  reason: 'sl_hit' | 'tp_hit' | 'manual';
}

/** Clamp price into the entry zone. */
export function clampToEntryZone(price: number, low: number, high: number): number {
  return Math.min(Math.max(price, low), high);
}

/** Apply slippage against the trader (worse fill). */
export function applySlippage(price: number, direction: Direction, slippageBps: number): number {
  const factor = slippageBps / 10_000;
  return direction === 'long' ? price * (1 + factor) : price * (1 - factor);
}

export function computeFee(notional: number, feeBps: number): number {
  return (notional * feeBps) / 10_000;
}

/** Unrealised P/L for an open position at a given mark price. */
export function unrealisedPnl(
  direction: Direction,
  entryPrice: number,
  markPrice: number,
  quantity: number,
): number {
  const diff = direction === 'long' ? markPrice - entryPrice : entryPrice - markPrice;
  return diff * quantity;
}

/** Realised P/L on close, excluding fees on entry (fees handled separately). */
export function realisedPnl(
  direction: Direction,
  entryPrice: number,
  exitPrice: number,
  quantity: number,
): number {
  return unrealisedPnl(direction, entryPrice, exitPrice, quantity);
}

/** Whether stop loss has been hit at the given price. */
export function isStopHit(direction: Direction, price: number, stopLoss: number): boolean {
  return direction === 'long' ? price <= stopLoss : price >= stopLoss;
}

/** Whether take profit has been hit at the given price. */
export function isTakeProfitHit(direction: Direction, price: number, takeProfit: number): boolean {
  return direction === 'long' ? price >= takeProfit : price <= takeProfit;
}
