import type { AuditEntry, BotStatus, Memo, OpenPosition, Portfolio, Stats, TradeRecord } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:4000';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const message = (payload as { error?: string } | null)?.error ?? `request failed with ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  memos: (params: { decision?: string; reviewStatus?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.decision) query.set('decision', params.decision);
    if (params.reviewStatus) query.set('reviewStatus', params.reviewStatus);
    query.set('limit', String(params.limit ?? 100));
    return request<{ memos: Memo[]; count: number }>(`/api/memos?${query.toString()}`);
  },

  memo: (id: number) => request<Memo>(`/api/memos/${id}`),

  watchlist: () => request<{ memos: Memo[]; count: number }>('/api/watchlist'),

  stats: () => request<Stats>('/api/stats'),

  botStatus: () => request<BotStatus>('/api/bot/status'),

  pauseBot: () => request<{ ok: true; paused: boolean }>('/api/bot/pause', { method: 'POST', body: '{}' }),

  resumeBot: () => request<{ ok: true; paused: boolean }>('/api/bot/resume', { method: 'POST', body: '{}' }),

  setExecutionMode: (mode: 'paper' | 'testnet') =>
    request<{ ok: true; mode: string }>('/api/bot/execution-mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }),

  setApproveThreshold: (threshold: number) =>
    request<{ ok: true; threshold: number }>('/api/bot/approve-threshold', {
      method: 'PUT',
      body: JSON.stringify({ threshold }),
    }),

  setSignalTimeframe: (timeframe: string) =>
    request<{ ok: true; timeframe: string }>('/api/bot/signal-timeframe', {
      method: 'PUT',
      body: JSON.stringify({ timeframe }),
    }),

  config: () =>
    request<{
      execution: { mode: string; slippageBps: number; feeBps: number };
      scoring: { thresholds: { approve: number; watchlist: number } };
      signalTimeframe: string;
      chartTimeframes: string[];
      volatility: { atrTimeframe: string };
    }>('/api/config'),

  trades: (limit = 50) => request<{ trades: TradeRecord[]; count: number }>(`/api/trades?limit=${limit}`),

  positions: () => request<{ positions: OpenPosition[]; count: number }>('/api/positions'),

  portfolio: () => request<Portfolio>('/api/portfolio'),

  setEquity: (equity: number) =>
    request<Portfolio>('/api/portfolio', {
      method: 'PUT',
      body: JSON.stringify({ equity }),
    }),

  audit: () => request<{ entries: AuditEntry[] }>('/api/review/audit?limit=100'),

  review: (memoId: number, action: 'acknowledged' | 'dismissed', notes: string, reviewer?: string) =>
    request<{ ok: true; memo: Memo }>(`/api/memos/${memoId}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, notes, reviewer }),
    }),
};

export { API_BASE_URL };
