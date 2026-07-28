import type { Candle, NewsItem, Timeframe } from '../types.js';

/**
 * Read-only market data. Deliberately has no order-placement surface: an
 * execution capability cannot be reached from anywhere in this codebase
 * because no interface here exposes one.
 */
export interface MarketDataProvider {
  readonly name: string;
  getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]>;
  getLastPrice(symbol: string): Promise<number>;
  /** Rejects with a descriptive error when the symbol is not tradable upstream. */
  assertSymbolSupported(symbol: string): Promise<void>;
}

export interface NewsProvider {
  readonly name: string;
  /** Headlines relevant to `symbol`, newest first, each with a sentiment score. */
  getNews(symbol: string, label: string, maxAgeHours: number): Promise<NewsItem[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
