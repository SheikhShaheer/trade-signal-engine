'use client';

import type { Portfolio, Stats } from '@/lib/types';

interface Props {
  stats: Stats | null;
  portfolio: Portfolio | null;
}

export function StatsBar({ stats, portfolio }: Props) {
  const lastRun = stats?.lastRun ?? null;
  const drawdown =
    portfolio && portfolio.peakEquity > 0
      ? ((portfolio.peakEquity - portfolio.equity) / portfolio.peakEquity) * 100
      : 0;

  return (
    <div className="stat-grid">
      <div className="stat">
        <div className="label">Awaiting review</div>
        <div className="value">{stats?.pendingReview ?? '—'}</div>
        <div className="sub">nothing acts on its own</div>
      </div>
      <div className="stat">
        <div className="label">Last 24h memos</div>
        <div className="value">
          {stats ? stats.last24h.approved + stats.last24h.watchlist + stats.last24h.rejected : '—'}
        </div>
        <div className="sub">
          {stats
            ? `${stats.last24h.approved} approved · ${stats.last24h.watchlist} watch · ${stats.last24h.rejected} rejected`
            : ''}
        </div>
      </div>
      <div className="stat">
        <div className="label">Equity</div>
        <div className="value">{portfolio ? portfolio.equity.toLocaleString() : '—'}</div>
        <div className="sub">
          {portfolio ? `${drawdown.toFixed(2)}% off peak · ${portfolio.openPositions.length} open` : ''}
        </div>
      </div>
      <div className="stat">
        <div className="label">Last scan</div>
        <div className="value">
          {lastRun ? `${Math.round((Date.now() - Date.parse(lastRun.finishedAt)) / 60_000)}m` : '—'}
        </div>
        <div className="sub">
          {lastRun
            ? [
                `${lastRun.instrumentsScanned} instruments`,
                `${lastRun.signalsDetected} signals`,
                `${lastRun.riskGateBlocked} blocked`,
                // Runs recorded before de-duplication existed have no counts.
                lastRun.suppressedDuplicates ? `${lastRun.suppressedDuplicates} suppressed` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : 'worker has not run yet'}
        </div>
      </div>
      <div className="stat">
        <div className="label">Snapshots stored</div>
        <div className="value">{stats ? stats.snapshotsStored.toLocaleString() : '—'}</div>
        <div className="sub">available for replay</div>
      </div>
    </div>
  );
}
