'use client';

import { useCallback, useEffect, useState } from 'react';
import { SignalRow } from '@/components/SignalRow';
import { api, API_BASE_URL } from '@/lib/api';
import type { Memo } from '@/lib/types';

export default function ReviewPage() {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const result = await api.pendingReview();
      setMemos(result.memos);
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Review</h1>
          <p>Compact queue. Click a row for profit, loss, and what price should do next.</p>
        </div>
        <span className="count-pill">{memos.length} waiting</span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="empty-inline">Loading…</div>
      ) : memos.length === 0 ? (
        <div className="empty-inline">Queue is clear. Come back after the next scan.</div>
      ) : (
        <div className="signal-list-compact panel">
          {memos.map((memo) => (
            <SignalRow key={memo.id} memo={memo} href={`/ideas/${memo.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}
