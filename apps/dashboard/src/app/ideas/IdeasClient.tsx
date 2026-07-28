'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { SignalRow } from '@/components/SignalRow';
import { api, API_BASE_URL } from '@/lib/api';
import type { Decision, Memo } from '@/lib/types';

const FILTERS: { id: Decision | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'approved', label: 'Strong' },
  { id: 'watchlist', label: 'Watch' },
  { id: 'rejected', label: 'Weak' },
];

export default function IdeasClient() {
  const search = useSearchParams();
  const filter = (search.get('filter') as Decision | 'all' | null) ?? 'all';
  const [memos, setMemos] = useState<Memo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.memos({ limit: 100 });
      setMemos(result.memos);
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(
    () => (filter === 'all' ? memos : memos.filter((m) => m.decision === filter)),
    [memos, filter],
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Ideas</h1>
          <p>Latest setup per coin and direction. One row each — open for full detail.</p>
        </div>
      </div>

      <div className="filter-row">
        {FILTERS.map((item) => (
          <Link
            key={item.id}
            href={item.id === 'all' ? '/ideas' : `/ideas?filter=${item.id}`}
            className={filter === item.id ? 'filter-chip active' : 'filter-chip'}
          >
            {item.label}
          </Link>
        ))}
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="empty-inline">No ideas in this filter.</div>
      ) : (
        <div className="signal-list-compact panel">
          {visible.map((memo) => (
            <SignalRow key={memo.id} memo={memo} />
          ))}
        </div>
      )}
    </div>
  );
}
