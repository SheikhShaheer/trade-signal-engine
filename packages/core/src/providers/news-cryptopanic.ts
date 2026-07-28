import type { NewsItem } from '../types.js';
import { fetchJson, type HttpOptions } from './http.js';
import { scoreSentiment } from './sentiment.js';
import type { NewsProvider } from './types.js';

interface CryptoPanicPost {
  id: number;
  title: string;
  url?: string;
  published_at: string;
  source?: { title?: string; domain?: string };
  votes?: { positive?: number; negative?: number; important?: number };
}

export interface CryptoPanicOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  baseUrl?: string;
}

/** BTCUSDT -> BTC, so the provider can be queried by currency code. */
function toCurrencyCode(symbol: string): string {
  return symbol.replace(/(USDT|USDC|BUSD|USD)$/i, '') || symbol;
}

export class CryptoPanicNewsProvider implements NewsProvider {
  readonly name = 'cryptopanic';
  private readonly http: HttpOptions;
  private readonly baseUrl: string;

  constructor(private readonly options: CryptoPanicOptions) {
    this.baseUrl = options.baseUrl ?? 'https://cryptopanic.com/api/v1';
    this.http = {
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      retryBackoffMs: options.retryBackoffMs,
      provider: this.name,
    };
  }

  async getNews(symbol: string, _label: string, maxAgeHours: number): Promise<NewsItem[]> {
    const currency = toCurrencyCode(symbol);
    const url = `${this.baseUrl}/posts/?auth_token=${encodeURIComponent(this.options.apiKey)}&currencies=${encodeURIComponent(currency)}&public=true`;
    const raw = await fetchJson<{ results?: CryptoPanicPost[] }>(url, this.http);
    const cutoff = Date.now() - maxAgeHours * 3_600_000;

    return (raw.results ?? [])
      .filter((post) => Date.parse(post.published_at) >= cutoff)
      .map<NewsItem>((post) => ({
        id: `cryptopanic-${post.id}`,
        headline: post.title,
        source: post.source?.title ?? post.source?.domain ?? 'cryptopanic',
        url: post.url,
        publishedAt: new Date(post.published_at).toISOString(),
        sentiment: this.combineSentiment(post),
      }))
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }

  /**
   * Blends the lexicon reading of the headline with community votes when the
   * post has any, since votes carry information the title alone does not.
   */
  private combineSentiment(post: CryptoPanicPost): number {
    const lexical = scoreSentiment(post.title);
    const positive = post.votes?.positive ?? 0;
    const negative = post.votes?.negative ?? 0;
    const totalVotes = positive + negative;
    if (totalVotes === 0) return lexical;
    const voteScore = (positive - negative) / totalVotes;
    return Math.max(-1, Math.min(1, lexical * 0.5 + voteScore * 0.5));
  }
}
