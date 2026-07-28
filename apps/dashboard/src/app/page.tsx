'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { SignalRow } from '@/components/SignalRow';
import { api, API_BASE_URL } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { Memo, Portfolio, Stats } from '@/lib/types';

export default function OverviewPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [pending, setPending] = useState<Memo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [statsResult, portfolioResult, pendingResult] = await Promise.all([
        api.stats(),
        api.portfolio(),
        api.pendingReview(),
      ]);
      setStats(statsResult);
      setPortfolio(portfolioResult);
      setPending(pendingResult.memos.slice(0, 5));
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}. Start it with npm run dev:api.`);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const lastRun = stats?.lastRun;
  const minutesAgo = lastRun
    ? Math.round((Date.now() - Date.parse(lastRun.finishedAt)) / 60_000)
    : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>What needs attention, how big the account is, and the latest scan.</p>
        </div>
        <Link href="/review" className="btn primary">
          Open review queue
        </Link>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <div className="metric-row">
        <div className="metric">
          <span>Waiting for you</span>
          <strong>{stats?.pendingReview ?? '—'}</strong>
        </div>
        <div className="metric">
          <span>Account</span>
          <strong>{portfolio ? formatMoney(portfolio.equity) : '—'}</strong>
        </div>
        <div className="metric">
          <span>Last scan</span>
          <strong>{minutesAgo === null ? '—' : `${minutesAgo}m ago`}</strong>
        </div>
        <div className="metric">
          <span>Ideas today</span>
          <strong>
            {stats
              ? stats.last24h.approved + stats.last24h.watchlist + stats.last24h.rejected
              : '—'}
          </strong>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>Needs review</h2>
          <Link href="/review">See all</Link>
        </div>
        {pending.length === 0 ? (
          <div className="empty-inline">Nothing waiting. The scanner will add ideas here.</div>
        ) : (
          <div className="signal-list-compact">
            {pending.map((memo) => (
              <SignalRow key={memo.id} memo={memo} href={`/ideas/${memo.id}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
