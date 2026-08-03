import type { Direction, Memo } from './types';

export function formatAge(timestamp: string): string {
  const minutes = Math.round((Date.now() - Date.parse(timestamp)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatMoney(value: number): string {
  if (Math.abs(value) >= 100) return `$${value.toFixed(0)}`;
  return `$${value.toFixed(2)}`;
}

export function formatPnl(value: number): string {
  const prefix = value >= 0 ? '+' : '−';
  return `${prefix}${formatMoney(Math.abs(value))}`;
}

export function unrealisedPnl(
  direction: Direction,
  entryPrice: number,
  markPrice: number,
  quantity: number,
): number {
  const diff = direction === 'long' ? markPrice - entryPrice : entryPrice - markPrice;
  return diff * quantity;
}

export function directionLabel(direction: Direction): string {
  return direction === 'long' ? 'Long · price up' : 'Short · price down';
}

export function expectedProfit(memo: Memo): number {
  const target = memo.tradePlan.targets[0] as number;
  return Math.abs(target - memo.tradePlan.referenceEntry) * memo.riskGateResult.sizing.quantity;
}

export function expectedLoss(memo: Memo): number {
  return memo.riskGateResult.sizing.riskAmount;
}

export function scoreTone(score: number): 'strong' | 'ok' | 'watch' | 'weak' {
  if (score >= 7.5) return 'strong';
  if (score >= 6.5) return 'ok';
  if (score >= 5) return 'watch';
  return 'weak';
}

export function scoreLabel(score: number): string {
  const tone = scoreTone(score);
  if (tone === 'strong') return 'Strong';
  if (tone === 'ok') return 'Decent';
  if (tone === 'watch') return 'Watch';
  return 'Weak';
}
