'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, API_BASE_URL } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { TradingViewChart } from '@/components/TradingViewChart';
import type { OpenPosition } from '@/lib/types';
import { timeframeToChartInterval } from '@/lib/symbols';

export default function PositionsPage() {
  const [positions, setPositions] = useState<OpenPosition[]>([]);
  const [chartTimeframe, setChartTimeframe] = useState('4h');
  const [selectedId, setSelectedId] = useState<number | undefined>();
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [result, botStatus] = await Promise.all([api.positions(), api.botStatus()]);
      setPositions(result.positions);
      setChartTimeframe(botStatus.signalTimeframe);
      setSelectedId((prev) => {
        if (prev && result.positions.some((p) => p.id === prev)) return prev;
        return result.positions[0]?.id;
      });
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

  const selected = positions.find((p) => p.id === selectedId) ?? positions[0];

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Open positions</h1>
          <p>Bot-managed positions with live TradingView chart.</p>
        </div>
        <span className="count-pill">{positions.length} open</span>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      {positions.length === 0 ? (
        <div className="empty-inline">No open positions.</div>
      ) : (
        <div className="positions-layout">
          <div className="signal-list-compact panel positions-list">
            {positions.map((pos) => (
              <button
                key={pos.id ?? `${pos.instrument}-${pos.openedAt}`}
                type="button"
                className={selected?.id === pos.id ? 'signal-row compact active' : 'signal-row compact'}
                onClick={() => setSelectedId(pos.id)}
              >
                <span className={`dir-chip ${pos.direction}`}>
                  {pos.direction === 'long' ? '↑ LONG' : '↓ SHORT'}
                </span>
                <span className="row-symbol">{pos.instrument}</span>
                <span className="row-meta">{formatMoney(pos.notional)} notional</span>
              </button>
            ))}
          </div>

          {selected && (
            <section className="panel chart-panel positions-chart">
              <div className="panel-head">
                <h2>{selected.instrument}</h2>
              </div>
              <TradingViewChart
                symbol={selected.instrument}
                interval={timeframeToChartInterval(chartTimeframe)}
                entry={selected.entryPrice}
                stop={selected.stopLoss}
                target={selected.takeProfit}
                large
              />
              <p className="muted chart-caption">
                qty {selected.quantity} · opened {new Date(selected.openedAt).toLocaleString()}
                {selected.unrealisedPnl !== undefined && (
                  <> · open P/L {selected.unrealisedPnl >= 0 ? '+' : ''}${selected.unrealisedPnl.toFixed(2)}</>
                )}
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
