'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { MemoCard } from '@/components/MemoCard';
import { StatsBar } from '@/components/StatsBar';
import { api, API_BASE_URL } from '@/lib/api';
import type { AuditEntry, Memo, Portfolio, Stats } from '@/lib/types';

type Tab = 'pending' | 'approved' | 'watchlist' | 'rejected' | 'audit';

const REFRESH_MS = 30_000;

/**
 * Stage 5 — the human review queue.
 *
 * This screen is the only place a generated memo becomes something a person has
 * acted on, and even then the action is manual: the engine has no order path.
 */
export default function Home() {
  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<Memo[]>([]);
  const [ranked, setRanked] = useState<Memo[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [pendingResult, rankedResult, statsResult, portfolioResult, auditResult] = await Promise.all([
        api.pendingReview(),
        api.memos({ limit: 150 }),
        api.stats(),
        api.portfolio(),
        api.audit(),
      ]);
      setPending(pendingResult.memos);
      setRanked(rankedResult.memos);
      setStats(statsResult);
      setPortfolio(portfolioResult);
      setAudit(auditResult.entries);
      setError(null);
    } catch {
      setError(
        `Cannot reach the API at ${API_BASE_URL}. Start it with "npm run dev:api" (and Postgres with "npm run db:up").`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const byDecision = useMemo(
    () => ({
      approved: ranked.filter((m) => m.decision === 'approved'),
      watchlist: ranked.filter((m) => m.decision === 'watchlist'),
      rejected: ranked.filter((m) => m.decision === 'rejected'),
    }),
    [ranked],
  );

  const visible = tab === 'pending' ? pending : tab === 'audit' ? [] : byDecision[tab];

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>Trade Decision Review Queue</h1>
          <p>
            Ranked decision memos from the 24/7 scanner. Best thing to look at is at the top. Every item here has
            already passed the risk gate; rejected items are kept below for audit and backtesting.
          </p>
        </div>
        <span className="no-exec-badge">No auto-execution · manual action only</span>
      </header>

      <StatsBar stats={stats} portfolio={portfolio} />

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <nav className="tabs" role="tablist">
        {(
          [
            ['pending', 'Awaiting review', pending.length],
            ['approved', 'Approved', byDecision.approved.length],
            ['watchlist', 'Watchlist', byDecision.watchlist.length],
            ['rejected', 'Rejected', byDecision.rejected.length],
            ['audit', 'Review log', audit.length],
          ] as [Tab, string, number][]
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label} <span className="count">{count}</span>
          </button>
        ))}
      </nav>

      {tab === 'audit' ? (
        audit.length === 0 ? (
          <div className="empty">No review decisions recorded yet.</div>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Memo</th>
                <th>Score</th>
                <th>Action</th>
                <th>Reviewer</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry, index) => (
                <tr key={`${entry.memoId}-${entry.createdAt}-${index}`}>
                  <td className="mono">{new Date(entry.createdAt).toLocaleString()}</td>
                  <td className="mono">#{entry.memoId}</td>
                  <td className="mono">{entry.memoScore.toFixed(1)}</td>
                  <td>{entry.action}</td>
                  <td>{entry.actor}</td>
                  <td>{entry.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : loading ? (
        <div className="empty">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="empty">
          {tab === 'pending'
            ? 'Nothing is waiting for review. The scanner queues a memo only when a plan passes the risk gate and clears the watchlist score.'
            : `No ${tab} memos in the recent window.`}
        </div>
      ) : (
        <div className="memo-list">
          {visible.map((memo, index) => (
            <MemoCard
              key={memo.id}
              memo={memo}
              expandedByDefault={tab === 'pending' && index === 0}
              onReviewed={() => void load()}
            />
          ))}
        </div>
      )}

      <p className="footnote">
        This system produces information, not orders. It has no broker or exchange trading credentials and no
        order-placement code. Acknowledging a memo records your decision in an audit log; placing the trade, if you
        choose to, is a separate manual act. Scores are a heuristic — replay them against stored history with{' '}
        <span className="mono">npm run backtest</span> before trusting them.
      </p>
    </main>
  );
}
