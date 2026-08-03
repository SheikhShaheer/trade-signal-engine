/** Map exchange symbol to TradingView widget identifier. */
export function toTradingViewSymbol(symbol: string): string {
  return `BINANCE:${symbol.toUpperCase()}`;
}
