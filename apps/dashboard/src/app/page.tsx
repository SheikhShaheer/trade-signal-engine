'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TradingViewChart } from '@/components/TradingViewChart';
import { SignalRow } from '@/components/SignalRow';
import { api, API_BASE_URL } from '@/lib/api';
import { formatMoney, formatPnl } from '@/lib/format';
import type { BotStatus, Memo, OpenPosition, Stats, TradeRecord } from '@/lib/types';

function primaryPosition(positions: OpenPosition[]): OpenPosition | undefined {
  if (positions.length === 0) return undefined;
  return [...positions].sort((a, b) => b.notional - a.notional)[0];
}

export default function BotHomePage() {
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [recentIdeas, setRecentIdeas] = useState<Memo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    try {
      const [botResult, statsResult, tradesResult, memosResult] = await Promise.all([
        api.botStatus(),
        api.stats(),
        api.trades(5),
        api.memos({ decision: 'approved', limit: 5 }),
      ]);
      setBot(botResult);
      setStats(statsResult);
      setTrades(tradesResult.trades);
      setRecentIdeas(memosResult.memos);
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

  const toggleBot = async () => {
    if (!bot) return;
    setToggling(true);
    try {
      if (bot.paused) await api.resumeBot();
      else await api.pauseBot();
      await load();
    } catch {
      setError('Could not update bot status.');
    } finally {
      setToggling(false);
    }
  };

  const lastRun = stats?.lastRun;
  const minutesAgo = lastRun
    ? Math.round((Date.now() - Date.parse(lastRun.finishedAt)) / 60_000)
    : null;

  const featured = useMemo(
    () => (bot ? primaryPosition(bot.openPositions) : undefined),
    [bot],
  );

  const modeLabel =
    bot?.mode === 'testnet' ? 'Testnet' : bot?.mode === 'paper' ? 'Paper' : bot?.mode ?? '—';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Trading bot</h1>
          <p>
            <span className={`mode-badge ${bot?.mode ?? 'paper'}`}>{modeLabel}</span>
            {' · '}
            Approved signals (score ≥ {bot?.approveThreshold ?? 7.5}) trade automatically.
          </p>
        </div>
        <button
          type="button"
          className={bot?.paused ? 'btn primary' : 'btn'}
          disabled={toggling || !bot}
          onClick={() => void toggleBot()}
        >
          {bot?.paused ? 'Resume bot' : 'Pause bot'}
        </button>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <div className="metric-row">
        <div className="metric">
          <span>Status</span>
          <strong>{bot?.paused ? 'Paused' : 'Running'}</strong>
        </div>
        <div className="metric">
          <span>Equity</span>
          <strong>{bot ? formatMoney(bot.equity) : '—'}</strong>
        </div>
        <div className="metric">
          <span>Today P/L</span>
          <strong className={bot && bot.dayRealisedPnl >= 0 ? 'profit-text' : 'loss-text'}>
            {bot ? formatPnl(bot.dayRealisedPnl) : '—'}
          </strong>
        </div>
        <div className="metric">
          <span>Open positions</span>
          <strong>{bot?.openCount ?? '—'}</strong>
        </div>
        <div className="metric">
          <span>Last scan</span>
          <strong>{minutesAgo === null ? '—' : `${minutesAgo}m ago`}</strong>
        </div>
        <div className="metric">
          <span>Trades last run</span>
          <strong>{stats?.executedLastRun ?? '—'}</strong>
        </div>
      </div>

      {featured && (
        <section className="panel">
          <div className="panel-head">
            <h2>
              {featured.instrument}{' '}
              <span className={`dir-chip ${featured.direction}`}>
                {featured.direction === 'long' ? 'LONG' : 'SHORT'}
              </span>
            </h2>
            <Link href="/positions">All positions</Link>
          </div>
          <TradingViewChart
            symbol={featured.instrument}
            entry={featured.entryPrice}
            stop={featured.stopLoss}
            target={featured.takeProfit}
            height={580}
          />
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Recent trades</h2>
          <Link href="/trades">See all</Link>
        </div>
        {trades.length === 0 ? (
          <div className="empty-inline">No trades yet. The bot will open positions on approved signals.</div>
        ) : (
          <div className="signal-list-compact">
            {trades.map((trade) => (
              <Link key={trade.order.id} href={`/ideas/${trade.memoId}`} className="signal-row compact">
                <span className={`dir-chip ${trade.direction}`}>
                  {trade.direction === 'long' ? '↑' : '↓'}
                </span>
                <span className="row-symbol">{trade.instrument}</span>
                <span className="row-meta">
                  {trade.order.mode === 'testnet' ? 'testnet · ' : ''}
                  {trade.entryFill ? `@ ${trade.entryFill.price}` : 'pending'}
                  {trade.realisedPnl !== undefined ? ` · ${formatPnl(trade.realisedPnl)}` : ''}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Latest approved ideas</h2>
          <Link href="/ideas">See all</Link>
        </div>
        {recentIdeas.length === 0 ? (
          <div className="empty-inline">No approved memos in the latest scan window.</div>
        ) : (
          <div className="signal-list-compact">
            {recentIdeas.map((memo) => (
              <SignalRow key={memo.id} memo={memo} href={`/ideas/${memo.id}`} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
