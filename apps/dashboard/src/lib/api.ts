import type { AuditEntry, Memo, Portfolio, Stats } from './types';

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

  pendingReview: () => request<{ memos: Memo[]; count: number }>('/api/review/pending'),

  stats: () => request<Stats>('/api/stats'),

  portfolio: () => request<Portfolio>('/api/portfolio'),

  audit: () => request<{ entries: AuditEntry[] }>('/api/review/audit?limit=50'),

  /**
   * Records a human review decision. Acknowledging requires a note; the API
   * enforces that too, so this cannot be bypassed from another client.
   */
  review: (memoId: number, action: 'acknowledged' | 'dismissed', notes: string, reviewer?: string) =>
    request<{ ok: true; memo: Memo; reminder: string }>(`/api/memos/${memoId}/review`, {
      method: 'POST',
      body: JSON.stringify({ action, notes, reviewer }),
    }),
};

export { API_BASE_URL };
