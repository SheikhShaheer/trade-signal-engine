import { describe, expect, it } from 'vitest';
import { timeframeToChartInterval, toTradingViewSymbol } from '../src/lib/symbols.js';

describe('toTradingViewSymbol', () => {
  it('maps exchange symbols to TradingView BINANCE prefix', () => {
    expect(toTradingViewSymbol('btcusdt')).toBe('BINANCE:BTCUSDT');
    expect(toTradingViewSymbol('ETHUSDT')).toBe('BINANCE:ETHUSDT');
  });
});

describe('timeframeToChartInterval', () => {
  it('maps engine timeframes to TradingView intervals', () => {
    expect(timeframeToChartInterval('15m')).toBe('15');
    expect(timeframeToChartInterval('1h')).toBe('60');
    expect(timeframeToChartInterval('4h')).toBe('240');
    expect(timeframeToChartInterval('1d')).toBe('D');
  });
});
