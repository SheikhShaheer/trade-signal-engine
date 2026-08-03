import { describe, expect, it } from 'vitest';
import { toTradingViewSymbol } from '../src/lib/symbols.js';

describe('toTradingViewSymbol', () => {
  it('maps exchange symbols to TradingView BINANCE prefix', () => {
    expect(toTradingViewSymbol('btcusdt')).toBe('BINANCE:BTCUSDT');
    expect(toTradingViewSymbol('ETHUSDT')).toBe('BINANCE:ETHUSDT');
  });
});
