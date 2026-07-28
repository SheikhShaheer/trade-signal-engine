import type { Candle, Timeframe } from '../types.js';
import { fetchJson, type HttpOptions } from './http.js';
import { ProviderError, type MarketDataProvider } from './types.js';

/** Engine timeframes to Binance kline intervals. */
const intervalMap: Record<Timeframe, string> = {
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

/** Binance kline tuple: [openTime, open, high, low, close, volume, closeTime, ...]. */
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

export interface BinanceOptions {
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
}

/**
 * Binance public REST market data. No API key and no signed endpoints, so this
 * client is structurally incapable of touching an account.
 */
export class BinanceProvider implements MarketDataProvider {
  readonly name = 'binance';
  private readonly http: HttpOptions;
  private supportedSymbols: Set<string> | undefined;

  constructor(private readonly options: BinanceOptions) {
    this.http = {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      retryBackoffMs: options.retryBackoffMs,
      provider: this.name,
    };
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const interval = intervalMap[timeframe];
    const capped = Math.min(limit, 1000);
    const url = `${this.options.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${capped}`;
    const raw = await fetchJson<RawKline[]>(url, this.http);

    const candles = raw.map<Candle>((k) => ({
      openTime: k[0],
      closeTime: k[6],
      open: Number.parseFloat(k[1]),
      high: Number.parseFloat(k[2]),
      low: Number.parseFloat(k[3]),
      close: Number.parseFloat(k[4]),
      volume: Number.parseFloat(k[5]),
    }));

    const invalid = candles.find(
      (c) => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close),
    );
    if (invalid) {
      throw new ProviderError(`${symbol} ${timeframe}: received a non-numeric candle`, this.name, false);
    }

    // The final kline is the candle still forming. Detectors that treat it as
    // closed would fire on incomplete information, so drop it.
    if (candles.length > 0 && (candles[candles.length - 1] as Candle).closeTime > Date.now()) {
      candles.pop();
    }
    return candles;
  }

  async getLastPrice(symbol: string): Promise<number> {
    const url = `${this.options.baseUrl}/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    const raw = await fetchJson<{ symbol: string; price: string }>(url, this.http);
    const price = Number.parseFloat(raw.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new ProviderError(`${symbol}: received an invalid price "${raw.price}"`, this.name, false);
    }
    return price;
  }

  async assertSymbolSupported(symbol: string): Promise<void> {
    if (!this.supportedSymbols) {
      const url = `${this.options.baseUrl}/api/v3/exchangeInfo?permissions=SPOT`;
      const raw = await fetchJson<{ symbols: { symbol: string; status: string }[] }>(url, this.http);
      this.supportedSymbols = new Set(raw.symbols.filter((s) => s.status === 'TRADING').map((s) => s.symbol));
    }
    if (!this.supportedSymbols.has(symbol)) {
      throw new ProviderError(`${symbol} is not a TRADING spot symbol on Binance`, this.name, false);
    }
  }
}
