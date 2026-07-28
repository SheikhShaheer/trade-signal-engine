'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, API_BASE_URL } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { Portfolio } from '@/lib/types';

export default function SettingsPage() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [equityInput, setEquityInput] = useState('10');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const current = await api.portfolio();
      setPortfolio(current);
      setEquityInput(String(current.equity));
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const equity = Number.parseFloat(equityInput);
      const updated = await api.setEquity(equity);
      setPortfolio(updated);
      setEquityInput(String(updated.equity));
      setMessage(`Account size set to ${formatMoney(updated.equity)}. Next scan uses this.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save account size.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Account size drives position sizing and risk ceilings. Works from $10 up.</p>
        </div>
      </div>

      <section className="panel settings-panel">
        <h2>Account size</h2>
        <p className="muted">
          Risk limits scale with equity (1% per trade by default, 1.5% hard ceiling). A $10
          account and a $10,000 account follow the same rules.
        </p>
        <label className="field">
          <span>Equity (USD)</span>
          <input
            type="number"
            min={10}
            step={1}
            value={equityInput}
            onChange={(event) => setEquityInput(event.target.value)}
          />
        </label>
        <div className="preset-row">
          {[10, 50, 100, 1000, 10_000].map((value) => (
            <button
              key={value}
              type="button"
              className="filter-chip"
              onClick={() => setEquityInput(String(value))}
            >
              ${value.toLocaleString()}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save account size'}
        </button>
        {portfolio && (
          <p className="muted">
            Current: {formatMoney(portfolio.equity)} · peak {formatMoney(portfolio.peakEquity)} ·{' '}
            {portfolio.openPositions.length} open positions
          </p>
        )}
        {message && <p className="ok">{message}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
