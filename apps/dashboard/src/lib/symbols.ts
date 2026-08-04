/** Map exchange symbol to TradingView widget identifier. */
export function toTradingViewSymbol(symbol: string): string {
  return `BINANCE:${symbol.toUpperCase()}`;
}

/** Map engine timeframe to TradingView chart interval. */
export function timeframeToChartInterval(timeframe: string): string {
  switch (timeframe) {
    case '15m':
      return '15';
    case '1h':
      return '60';
    case '4h':
      return '240';
    case '1d':
      return 'D';
    default:
      return '240';
  }
}
