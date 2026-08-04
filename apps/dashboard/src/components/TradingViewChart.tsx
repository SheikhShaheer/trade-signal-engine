'use client';

import { useEffect, useRef, useState } from 'react';
import { toTradingViewSymbol } from '@/lib/symbols';
import { formatMoney } from '@/lib/format';

interface Props {
  symbol: string;
  interval?: string;
  /** Fixed height in px. Ignored when `large` is true. */
  height?: number;
  /** Tall chart for bot home / positions. */
  large?: boolean;
  entry?: number;
  stop?: number;
  target?: number;
}

function computeLargeHeight(): number {
  if (typeof window === 'undefined') return 900;
  return Math.max(720, Math.min(Math.round(window.innerHeight * 0.82), 1100));
}

/**
 * TradingView Advanced Chart embed. Free widget — levels shown in legend only.
 * Container height must be set in pixels before the script runs or autosize collapses.
 */
export function TradingViewChart({
  symbol,
  interval = '240',
  height = 420,
  large = false,
  entry,
  stop,
  target,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chartHeight, setChartHeight] = useState(() => (large ? computeLargeHeight() : height));

  useEffect(() => {
    if (large) {
      setChartHeight(computeLargeHeight());
      const onResize = () => setChartHeight(computeLargeHeight());
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    setChartHeight(height);
  }, [large, height]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = '';
    container.style.height = `${chartHeight}px`;
    container.style.minHeight = `${chartHeight}px`;

    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.height = `${chartHeight}px`;
    widget.style.width = '100%';
    container.appendChild(widget);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: false,
      width: '100%',
      height: chartHeight,
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
  }, [symbol, interval, chartHeight]);

  return (
    <div className={`chart-wrap${large ? ' chart-wrap-large' : ''}`}>
      <div
        ref={containerRef}
        className="tradingview-widget-container"
        style={{ height: chartHeight, minHeight: chartHeight }}
      />
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
