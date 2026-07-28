'use client';

import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { Memo } from '@/lib/types';

interface Props {
  memo: Memo;
  expandedByDefault?: boolean;
  onReviewed: () => void;
}

function formatAge(timestamp: string): string {
  const minutes = Math.round((Date.now() - Date.parse(timestamp)) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One decision memo, with the review gate attached.
 *
 * The gate is the whole point of this screen: a memo can only leave the pending
 * state because a person read it, typed a reason, and clicked. There is no bulk
 * action and no "approve all" — both would defeat the purpose.
 */
export function MemoCard({ memo, expandedByDefault = false, onReviewed }: Props) {
  const [expanded, setExpanded] = useState(expandedByDefault);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState<'acknowledged' | 'dismissed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = memo.tradePlan;
  const gate = memo.riskGateResult;
  const isPending = memo.review?.status === 'pending';
  const failedChecks = gate.checks.filter((c) => !c.pass);

  const submit = async (action: 'acknowledged' | 'dismissed') => {
    setError(null);
    if (action === 'acknowledged' && notes.trim().length < 3) {
      setError('Write a short note explaining why you are accepting this before you can acknowledge it.');
      return;
    }
    setSubmitting(action);
    try {
      await api.review(memo.id, action, notes.trim());
      onReviewed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record the review. Is the API running?');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <article className="memo" data-decision={memo.decision}>
      <button
        type="button"
        className="memo-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="score">{memo.score.toFixed(1)}</span>
        <span className="instrument">{memo.instrument}</span>
        <span className={`pill ${memo.direction}`}>{memo.direction}</span>
        <span className={`pill ${memo.decision}`}>{memo.decision}</span>
        {memo.review && <span className={`pill ${memo.review.status}`}>{memo.review.status}</span>}
        <span className="memo-levels">
          <span>
            entry <b>{plan.entryZone.low}–{plan.entryZone.high}</b>
          </span>
          <span>
            stop <b>{plan.stopLoss}</b>
          </span>
          <span>
            TP1 <b>{plan.targets[0]}</b>
          </span>
          <span>
            R:R <b>{plan.riskRewardRatio.toFixed(2)}</b>
          </span>
          <span>{formatAge(memo.timestamp)}</span>
        </span>
      </button>

      {expanded && (
        <div className="memo-body">
          <p className="rationale">{memo.rationale}</p>

          <div className="columns">
            <div>
              <h3 className="section-title">Trade plan ({plan.timeframe})</h3>
              <dl className="kv">
                <dt>Entry zone</dt>
                <dd>
                  {plan.entryZone.low} – {plan.entryZone.high}
                </dd>
                <dt>Stop loss</dt>
                <dd>{plan.stopLoss}</dd>
                <dt>Targets</dt>
                <dd>{plan.targets.join(' / ')}</dd>
                <dt>Risk / reward</dt>
                <dd>{plan.riskRewardRatio.toFixed(2)} : 1</dd>
                <dt>Risk per unit</dt>
                <dd>{plan.riskPerUnit}</dd>
                <dt>ATR used</dt>
                <dd>{plan.atrUsed}</dd>
                <dt>Position size</dt>
                <dd>
                  {gate.sizing.quantity} units ({gate.sizing.notional.toFixed(2)} notional)
                </dd>
                <dt>At risk</dt>
                <dd>
                  {gate.sizing.riskAmount.toFixed(2)} ({(gate.sizing.riskPctOfEquity * 100).toFixed(2)}% of equity)
                </dd>
                <dt>Invalidation</dt>
                <dd>{plan.invalidation}</dd>
              </dl>

              <h3 className="section-title">Score breakdown</h3>
              <div className="rows">
                {memo.scoreBreakdown.map((component) => (
                  <div className="row" key={component.component}>
                    <span className="name">{component.component}</span>
                    <span className="bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(component.raw * 100)}%` }} />
                    </span>
                    <span className="mono">
                      {component.contribution.toFixed(2)} / {(component.weight * 10).toFixed(1)}
                    </span>
                    <span className="detail">{component.basis}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="section-title">Signals fired</h3>
              <div className="rows">
                {memo.signalsFired.length === 0 && <span className="detail">no detectors fired</span>}
                {memo.signalsFired.map((signal) => (
                  <div className="row" key={signal.name}>
                    <span className="name">{signal.name}</span>
                    <span className="mono">{signal.strength.toFixed(2)}</span>
                    <span className="detail">{signal.rationale}</span>
                  </div>
                ))}
              </div>

              <h3 className="section-title">
                Risk gate — {gate.overallPass ? 'passed' : `blocked on ${failedChecks.length} check(s)`}
              </h3>
              <div className="rows">
                {gate.checks.map((check) => (
                  <div className="row" key={check.check}>
                    <span className={`check-mark ${check.pass ? 'pass' : 'fail'}`}>{check.pass ? '✓' : '✕'}</span>
                    <span className="name">{check.check}</span>
                    <span className="mono">
                      {check.valueChecked} / {check.limit}
                    </span>
                    <span className="detail">{check.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {isPending ? (
            <div className="review-gate">
              <h4>Human review required</h4>
              <p>
                Recording a decision here does not place, size or send an order anywhere. If you act on this idea,
                you place the trade yourself. Acknowledging requires a note so the audit log shows your reasoning.
              </p>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Why are you accepting or passing on this? e.g. taking it at the lower half of the entry zone, half size."
                aria-label="Review note"
              />
              <div className="review-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void submit('acknowledged')}
                  disabled={submitting !== null}
                >
                  {submitting === 'acknowledged' ? 'Recording…' : 'Acknowledge — I will act on this manually'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void submit('dismissed')}
                  disabled={submitting !== null}
                >
                  {submitting === 'dismissed' ? 'Recording…' : 'Dismiss'}
                </button>
                {memo.review && (
                  <span className="detail">expires {new Date(memo.review.expiresAt).toLocaleString()}</span>
                )}
              </div>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
          ) : (
            memo.review &&
            (memo.review.status === 'superseded' ? (
              <div className="reviewed-note">
                <strong>superseded</strong> — a later scan produced a fresher memo for this instrument and
                direction, so this one was never reviewed. Kept for audit and backtesting.
              </div>
            ) : memo.review.status === 'suppressed' ? (
              <div className="reviewed-note">
                <strong>suppressed</strong> — the same idea was reviewed recently, so this repeat was kept out
                of the queue rather than asking again. Kept for audit and backtesting.
              </div>
            ) : (
              <div className="reviewed-note">
                <strong>{memo.review.status}</strong>
                {memo.review.reviewedBy ? ` by ${memo.review.reviewedBy}` : ''}
                {memo.review.reviewedAt ? ` on ${new Date(memo.review.reviewedAt).toLocaleString()}` : ''}
                {memo.review.notes ? ` — “${memo.review.notes}”` : ''}
              </div>
            ))
          )}

          {!memo.review && (
            <div className="reviewed-note">
              This memo was {memo.decision} and never entered the review queue. It is kept for audit and
              backtesting.
            </div>
          )}
        </div>
      )}
    </article>
  );
}
