'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, API_BASE_URL } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { BotStatus, Portfolio } from '@/lib/types';

export default function SettingsPage() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [slippageBps, setSlippageBps] = useState<number | null>(null);
  const [feeBps, setFeeBps] = useState<number | null>(null);
  const [equityInput, setEquityInput] = useState('10');
  const [executionMode, setExecutionMode] = useState<'paper' | 'testnet'>('paper');
  const [approveThreshold, setApproveThreshold] = useState('7.5');
  const [watchlistThreshold, setWatchlistThreshold] = useState(5);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [current, botStatus, cfg] = await Promise.all([
        api.portfolio(),
        api.botStatus(),
        api.config(),
      ]);
      setPortfolio(current);
      setBot(botStatus);
      setExecutionMode(botStatus.mode === 'testnet' ? 'testnet' : 'paper');
      setApproveThreshold(String(botStatus.approveThreshold ?? cfg.scoring.thresholds.approve));
      setWatchlistThreshold(cfg.scoring.thresholds.watchlist);
      setSlippageBps(cfg.execution.slippageBps);
      setFeeBps(cfg.execution.feeBps);
      setEquityInput(String(current.equity));
      setError(null);
    } catch {
      setError(`Cannot reach API at ${API_BASE_URL}.`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveEquity = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const equity = Number.parseFloat(equityInput);
      const updated = await api.setEquity(equity);
      setPortfolio(updated);
      setEquityInput(String(updated.equity));
      setMessage(`Account size set to ${formatMoney(updated.equity)}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save account size.');
    } finally {
      setSaving(false);
    }
  };

  const saveExecutionMode = async (mode: 'paper' | 'testnet') => {
    setToggling(true);
    setMessage(null);
    setError(null);
    try {
      await api.setExecutionMode(mode);
      setExecutionMode(mode);
      setMessage(`Execution mode set to ${mode}. New trades use this mode on the next signal.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change execution mode.');
    } finally {
      setToggling(false);
    }
  };

  const saveApproveThreshold = async () => {
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const threshold = Number.parseFloat(approveThreshold);
      const updated = await api.setApproveThreshold(threshold);
      setApproveThreshold(String(updated.threshold));
      setMessage(`Approval threshold set to ${updated.threshold}. Applies on the next scan.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save approval threshold.');
    } finally {
      setSaving(false);
    }
  };

  const toggleBot = async () => {
    if (!bot) return;
    setToggling(true);
    setError(null);
    try {
      if (bot.paused) await api.resumeBot();
      else await api.pauseBot();
      await load();
      setMessage(bot.paused ? 'Bot resumed.' : 'Bot paused.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update bot status.');
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Account size, execution mode, and bot controls.</p>
        </div>
      </div>

      <section className="panel settings-panel">
        <h2>Trade acceptance</h2>
        <p className="muted">
          Minimum score (0–10) for the bot to auto-trade. Must be above the watchlist cutoff (
          {watchlistThreshold}).
        </p>
        <label className="field">
          <span>Approval threshold</span>
          <input
            type="number"
            min={watchlistThreshold + 0.01}
            max={10}
            step={0.1}
            value={approveThreshold}
            onChange={(event) => setApproveThreshold(event.target.value)}
          />
        </label>
        <div className="preset-row">
          {[5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map((value) => (
            <button
              key={value}
              type="button"
              className="filter-chip"
              onClick={() => setApproveThreshold(String(value))}
            >
              {value}
            </button>
          ))}
        </div>
        <button type="button" className="btn primary" disabled={saving} onClick={() => void saveApproveThreshold()}>
          {saving ? 'Saving…' : 'Save approval threshold'}
        </button>
      </section>

      <section className="panel settings-panel">
        <h2>Execution mode</h2>
        <p className="muted">
          Paper simulates fills locally. Testnet sends real orders to Binance Spot Testnet (long-only).
        </p>
        <p>
          Testnet API keys:{' '}
          <strong>{bot?.testnetConfigured ? 'Configured' : 'Not configured'}</strong>
          {!bot?.testnetConfigured && ' — add BINANCE_TESTNET_API_KEY/SECRET to .env'}
        </p>
        {slippageBps !== null && feeBps !== null && (
          <p className="muted">
            Paper assumptions: {slippageBps} bps slippage, {feeBps} bps fee
          </p>
        )}
        <div className="preset-row">
          <button
            type="button"
            className={executionMode === 'paper' ? 'filter-chip active' : 'filter-chip'}
            disabled={toggling}
            onClick={() => void saveExecutionMode('paper')}
          >
            Paper
          </button>
          <button
            type="button"
            className={executionMode === 'testnet' ? 'filter-chip active' : 'filter-chip'}
            disabled={toggling || !bot?.testnetConfigured}
            onClick={() => void saveExecutionMode('testnet')}
          >
            Binance Testnet
          </button>
        </div>
        <p>
          Active mode: <strong>{executionMode}</strong> · bot{' '}
          <strong>{bot?.paused ? 'paused' : 'running'}</strong>
        </p>
        <button type="button" className="btn primary" disabled={toggling || !bot} onClick={() => void toggleBot()}>
          {toggling ? 'Updating…' : bot?.paused ? 'Resume bot' : 'Pause bot (kill switch)'}
        </button>
      </section>

      <section className="panel settings-panel">
        <h2>Account size</h2>
        <p className="muted">Risk limits scale with equity. Works from $10 up.</p>
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
        <button type="button" className="btn primary" disabled={saving} onClick={() => void saveEquity()}>
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
