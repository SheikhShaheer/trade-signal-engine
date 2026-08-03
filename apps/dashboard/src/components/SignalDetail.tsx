'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import {
  directionLabel,
  expectedLoss,
  expectedProfit,
  formatAge,
  formatMoney,
  scoreLabel,
} from '@/lib/format';
import type { Memo } from '@/lib/types';

interface Props {
  memo: Memo;
  onReviewed?: () => void;
}

export function SignalDetail({ memo, onReviewed }: Props) {
  const router = useRouter();
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState<'acknowledged' | 'dismissed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = memo.tradePlan;
  const gate = memo.riskGateResult;
  const profit = expectedProfit(memo);
  const loss = expectedLoss(memo);
  const target = plan.targets[0] as number;
  const isPending = memo.review?.status === 'pending';

  const submit = async (action: 'acknowledged' | 'dismissed') => {
    setError(null);
    if (action === 'acknowledged' && notes.trim().length < 3) {
      setError('Add a short note before acknowledging.');
      return;
    }
    setSubmitting(action);
    try {
      await api.review(memo.id, action, notes.trim());
      onReviewed?.();
      router.refresh();
      router.push('/watchlist');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the review.');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="detail">
      <div className="detail-hero">
        <div>
          <div className="detail-kicker">#{memo.id} · {formatAge(memo.timestamp)}</div>
          <h1>
            <span className={`dir-chip ${memo.direction}`}>
              {memo.direction === 'long' ? '↑ LONG' : '↓ SHORT'}
            </span>{' '}
            {memo.instrument}
          </h1>
          <p>{directionLabel(memo.direction)}. Score {memo.score.toFixed(1)} · {scoreLabel(memo.score)}.</p>
        </div>
        <div className="pl-board">
          <div className="pl-cell profit">
            <span>If target hits</span>
            <strong>+{formatMoney(profit)}</strong>
            <em>at {target}</em>
          </div>
          <div className="pl-cell loss">
            <span>If stop hits</span>
            <strong>−{formatMoney(loss)}</strong>
            <em>at {plan.stopLoss}</em>
          </div>
        </div>
      </div>

      <div className="path-strip">
        <div>
          <span>Entry</span>
          <strong>
            {plan.entryZone.low} – {plan.entryZone.high}
          </strong>
        </div>
        <span className="path-arrow">{memo.direction === 'long' ? '→' : '→'}</span>
        <div>
          <span>First target</span>
          <strong className="text-profit">{target}</strong>
        </div>
        <span className="path-arrow">/</span>
        <div>
          <span>Stop</span>
          <strong className="text-loss">{plan.stopLoss}</strong>
        </div>
      </div>

      <p className="detail-copy">
        {memo.direction === 'long'
          ? `Price needs to rise toward ${target}. A drop to ${plan.stopLoss} kills the idea.`
          : `Price needs to fall toward ${target}. A rise to ${plan.stopLoss} kills the idea.`}
      </p>

      <div className="detail-grid">
        <section className="panel">
          <h2>Plan</h2>
          <dl className="kv">
            <dt>Timeframe</dt>
            <dd>{plan.timeframe}</dd>
            <dt>Risk / reward</dt>
            <dd>{plan.riskRewardRatio.toFixed(2)} : 1</dd>
            <dt>Size</dt>
            <dd>
              {gate.sizing.quantity} ({formatMoney(gate.sizing.notional)})
            </dd>
            <dt>Invalid if</dt>
            <dd>{plan.invalidation}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Why</h2>
          <ul className="signal-list">
            {memo.signalsFired.map((signal) => (
              <li key={signal.name}>
                <strong>{signal.name}</strong>
                <span>{signal.rationale}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Risk checks</h2>
          <ul className="check-list">
            {gate.checks.map((check) => (
              <li key={check.check} className={check.pass ? 'pass' : 'fail'}>
                <span>{check.pass ? '✓' : '✕'}</span>
                <div>
                  <strong>{check.check.replace(/-/g, ' ')}</strong>
                  <em>{check.detail}</em>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {memo.decision === 'approved' && (
        <section className="review-box">
          <h2>Bot action</h2>
          <p>Approved memos are auto-traded in paper mode. Check Trades for fill details.</p>
        </section>
      )}

      {isPending && memo.decision !== 'approved' ? (
        <section className="review-box">
          <h2>Watchlist note</h2>
          <p>Watchlist ideas are not auto-traded. You can log a note for your records.</p>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Why take or skip this? e.g. half size, wait for better entry."
            aria-label="Review note"
          />
          <div className="review-actions">
            <button
              type="button"
              className="btn primary"
              disabled={submitting !== null}
              onClick={() => void submit('acknowledged')}
            >
              {submitting === 'acknowledged' ? 'Saving…' : 'I’ll take this manually'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={submitting !== null}
              onClick={() => void submit('dismissed')}
            >
              {submitting === 'dismissed' ? 'Saving…' : 'Skip'}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      ) : (
        memo.review && (
          <section className="review-box muted">
            <strong>{memo.review.status}</strong>
            {memo.review.notes ? ` — ${memo.review.notes}` : ''}
          </section>
        )
      )}
    </div>
  );
}
