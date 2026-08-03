import { createHmac } from 'node:crypto';
import { ProviderError } from '../providers/types.js';

export interface BinanceTestnetOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface BinanceOrderFill {
  price: number;
  qty: number;
  commission: number;
}

export interface BinanceOrderResult {
  orderId: number;
  symbol: string;
  status: string;
  executedQty: number;
  fills: BinanceOrderFill[];
  avgPrice: number;
}

/**
 * Signed REST client for Binance Spot **Testnet** only.
 * baseUrl must be testnet.binance.vision — never mainnet.
 */
export class BinanceTestnetClient {
  constructor(private readonly options: BinanceTestnetOptions) {
    if (!options.baseUrl.includes('testnet.binance.vision')) {
      throw new Error('BinanceTestnetClient requires testnet.binance.vision base URL');
    }
  }

  private sign(query: string): string {
    return createHmac('sha256', this.options.apiSecret).update(query).digest('hex');
  }

  private async signedPost(path: string, params: Record<string, string | number>): Promise<unknown> {
    const timestamp = Date.now();
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      body.set(key, String(value));
    }
    body.set('timestamp', String(timestamp));
    body.set('signature', this.sign(body.toString()));

    const url = `${this.options.baseUrl}${path}?${body.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'X-MBX-APIKEY': this.options.apiKey,
          accept: 'application/json',
        },
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ProviderError(
          `binance-testnet order failed ${response.status}: ${text.slice(0, 200)}`,
          'binance-testnet',
          false,
        );
      }
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async marketBuy(symbol: string, quantity: string): Promise<BinanceOrderResult> {
    return this.placeMarketOrder(symbol, 'BUY', quantity);
  }

  async marketSell(symbol: string, quantity: string): Promise<BinanceOrderResult> {
    return this.placeMarketOrder(symbol, 'SELL', quantity);
  }

  private async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
  ): Promise<BinanceOrderResult> {
    const raw = (await this.signedPost('/api/v3/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
    })) as {
      orderId: number;
      symbol: string;
      status: string;
      executedQty: string;
      fills?: { price: string; qty: string; commission: string }[];
    };

    const fills = (raw.fills ?? []).map((f) => ({
      price: Number.parseFloat(f.price),
      qty: Number.parseFloat(f.qty),
      commission: Number.parseFloat(f.commission),
    }));

    const executedQty = Number.parseFloat(raw.executedQty);
    const notional = fills.reduce((acc, f) => acc + f.price * f.qty, 0);
    const avgPrice = executedQty > 0 ? notional / executedQty : 0;
    const fee = fills.reduce((acc, f) => acc + f.commission, 0);

    return {
      orderId: raw.orderId,
      symbol: raw.symbol,
      status: raw.status,
      executedQty,
      fills,
      avgPrice,
    };
  }
}

/** Format quantity to step precision for Binance order API. */
export function formatQuantity(quantity: number, step: number): string {
  if (step <= 0) return quantity.toString();
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const factor = 10 ** decimals;
  const rounded = Math.floor(quantity * factor) / factor;
  return rounded.toFixed(decimals);
}

export function totalFee(fills: BinanceOrderFill[]): number {
  return fills.reduce((acc, f) => acc + f.commission, 0);
}
