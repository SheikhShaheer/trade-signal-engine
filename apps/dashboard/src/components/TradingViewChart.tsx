'use client';

import { useEffect, useRef } from 'react';
import { toTradingViewSymbol } from '@/lib/symbols';
import { formatMoney } from '@/lib/format';

interface Props {
  symbol: string;
  interval?: string;
  height?: number;
  entry?: number;
  stop?: number;
  target?: number;
}

/**
 * TradingView Advanced Chart embed. Free widget — levels shown in legend only.
 */
export function TradingViewChart({
  symbol,
  interval = '240',
  height = 420,
  entry,
  stop,
  target,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = '';
    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = '100%';
    container.appendChild(widget);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: toTradingViewSymbol(symbol),
      interval,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      allow_symbol_change: false,
      calendar: false,
      hide_top_toolbar: false,
      hide_legend: false,
      support_host: 'https://www.tradingview.com',
    });
    container.appendChild(script);
  }, [symbol, interval]);

  return (
    <div className="chart-wrap">
      <div ref={containerRef} className="tradingview-widget-container" style={{ height }} />
      {(entry !== undefined || stop !== undefined || target !== undefined) && (
        <div className="chart-levels">
          {entry !== undefined && <span>Entry {formatMoney(entry)}</span>}
          {stop !== undefined && <span className="loss-text">Stop {formatMoney(stop)}</span>}
          {target !== undefined && <span className="profit-text">Target {formatMoney(target)}</span>}
        </div>
      )}
    </div>
  );
}
