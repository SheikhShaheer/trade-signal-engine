'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, API_BASE_URL } from '@/lib/api';
import { formatMoney, formatPnl } from '@/lib/format';
import type { TradeRecord } from '@/lib/types';

export default function TradesPage() {
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.trades(100);
      setTrades(result.trades);
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
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
          <h1>Trades</h1>
          <p>Paper entries and exits linked to decision memos.</p>
        </div>
        <span className="count-pill">{trades.length} total</span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {trades.length === 0 ? (
        <div className="empty-inline">No trades recorded yet.</div>
      ) : (
        <div className="signal-list-compact panel">
          {trades.map((trade) => (
            <Link key={trade.order.id} href={`/ideas/${trade.memoId}`} className="signal-row compact">
              <span className={`dir-chip ${trade.direction}`}>
                {trade.direction === 'long' ? '↑ LONG' : '↓ SHORT'}
              </span>
              <span className="row-symbol">{trade.instrument}</span>
              <span className="row-meta">
                qty {trade.order.quantity}
                {trade.entryFill ? ` · in ${formatMoney(trade.entryFill.price)}` : ''}
                {trade.exitFill ? ` · out ${formatMoney(trade.exitFill.price)}` : ' · open'}
              </span>
              <span className={trade.realisedPnl !== undefined && trade.realisedPnl >= 0 ? 'profit-text' : 'loss-text'}>
                {trade.realisedPnl !== undefined ? formatPnl(trade.realisedPnl) : '—'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
