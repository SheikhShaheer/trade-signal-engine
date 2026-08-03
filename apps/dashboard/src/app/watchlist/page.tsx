'use client';

import { useCallback, useEffect, useState } from 'react';
import { SignalRow } from '@/components/SignalRow';
import { api, API_BASE_URL } from '@/lib/api';
import type { Memo } from '@/lib/types';

export default function WatchlistPage() {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [watchlistMin, setWatchlistMin] = useState(5);
  const [approveMin, setApproveMin] = useState(7.5);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [result, cfg] = await Promise.all([api.watchlist(), api.config()]);
      setMemos(result.memos);
      setWatchlistMin(cfg.scoring.thresholds.watchlist);
      setApproveMin(cfg.scoring.thresholds.approve);
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
          <h1>Watchlist</h1>
          <p>
            Ideas scored {watchlistMin}–{approveMin} — observed but not auto-traded.
          </p>
        </div>
        <span className="count-pill">{memos.length} ideas</span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="empty-inline">Loading…</div>
      ) : memos.length === 0 ? (
        <div className="empty-inline">No watchlist ideas in the latest window.</div>
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
