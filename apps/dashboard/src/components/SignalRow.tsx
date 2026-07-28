'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  directionLabel,
  expectedLoss,
  expectedProfit,
  formatAge,
  formatMoney,
  scoreLabel,
  scoreTone,
} from '@/lib/format';
import type { Memo } from '@/lib/types';

interface Props {
  memo: Memo;
  href?: string;
}

function RelativeAge({ timestamp }: { timestamp: string }) {
  const [label, setLabel] = useState('…');
  useEffect(() => {
    setLabel(formatAge(timestamp));
  }, [timestamp]);
  return <span className="signal-meta">{label}</span>;
}

/** One compact row: direction, coin, P/L, score — enough to scan a queue. */
export function SignalRow({ memo, href }: Props) {
  const plan = memo.tradePlan;
  const profit = expectedProfit(memo);
  const loss = expectedLoss(memo);
  const target = plan.targets[0];
  const tone = scoreTone(memo.score);
  const destination = href ?? `/ideas/${memo.id}`;

  return (
    <Link href={destination} className="signal-row">
      <span className={`dir-chip ${memo.direction}`} title={directionLabel(memo.direction)}>
        {memo.direction === 'long' ? '↑ LONG' : '↓ SHORT'}
      </span>
      <span className="signal-main">
        <strong>{memo.instrument}</strong>
        <span className="signal-sub">
          {memo.direction === 'long' ? `up → ${target}` : `down → ${target}`} · {plan.timeframe}
        </span>
      </span>
      <span className="pl-pair">
        <span className="profit">+{formatMoney(profit)}</span>
        <span className="loss">−{formatMoney(loss)}</span>
      </span>
      <span className={`score-chip ${tone}`}>
        {memo.score.toFixed(1)} · {scoreLabel(memo.score)}
      </span>
      <RelativeAge timestamp={memo.timestamp} />
    </Link>
  );
}
