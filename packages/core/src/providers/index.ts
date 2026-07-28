import type { Env } from '../config/env.js';
import type { DataConfig } from '../config/schema.js';
import { BinanceProvider } from './binance.js';
import { CryptoPanicNewsProvider } from './news-cryptopanic.js';
import { StubNewsProvider } from './news-stub.js';
import type { MarketDataProvider, NewsProvider } from './types.js';

export * from './types.js';
export { BinanceProvider } from './binance.js';
export { StubNewsProvider } from './news-stub.js';
export { CryptoPanicNewsProvider } from './news-cryptopanic.js';
export { scoreSentiment, aggregateSentiment } from './sentiment.js';
export { fetchJson, type HttpOptions } from './http.js';

export function createMarketDataProvider(env: Env, data: DataConfig): MarketDataProvider {
  return new BinanceProvider({
    baseUrl: env.BINANCE_BASE_URL,
    timeoutMs: data.requestTimeoutMs,
    maxRetries: data.maxRetries,
    retryBackoffMs: data.retryBackoffMs,
  });
}

export function createNewsProvider(env: Env, data: DataConfig): NewsProvider {
  if (env.NEWS_PROVIDER === 'cryptopanic') {
    return new CryptoPanicNewsProvider({
      apiKey: env.CRYPTOPANIC_API_KEY as string,
      timeoutMs: data.requestTimeoutMs,
      maxRetries: data.maxRetries,
      retryBackoffMs: data.retryBackoffMs,
    });
  }
  return new StubNewsProvider();
}
