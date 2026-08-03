# 24/7 Paper Trading Bot

A continuously-running system that scans crypto markets, detects signals, builds trade plans, passes every plan through a hard risk gate, scores decision memos, and **automatically executes approved trades in paper mode**.

Approved memos (score ≥ 7.5, risk gate passed) open simulated positions immediately — no manual approval. The bot manages exits on stop loss and first take-profit. Live exchange credentials are not used; [a test forbids them](#paper-only-no-live-credentials) until a deliberate live phase.

---

## Pipeline

```
[1] Scanner → [2] Detectors → [3] Planner → [4] Risk Gate → [6] Scorer → [7] Paper Executor
                                                              ↘ watchlist memos (observed only)
```

Each stage takes typed input and returns typed output. Blocked plans and rejected memos are retained for backtesting.

| Stage | Module | What it does |
|---|---|---|
| 1. Scanner | `packages/core/src/stages/scanner.ts` | OHLCV, volume, MAs, trend, key levels, news → `MarketSnapshot` |
| 2. Detectors | `packages/core/src/stages/detectors/` | Five detectors → `SignalCandidate` |
| 3. Planner | `packages/core/src/stages/planner.ts` | Entry zone, stop, targets, computed R:R |
| 4. Risk gate | `packages/core/src/stages/risk-gate/` | Sizing, exposure, drawdown, volatility, max-loss |
| 6. Scoring | `packages/core/src/stages/scoring.js` | Weighted 0–10 score → `approved` / `watchlist` / `rejected` |
| 7. Execution | `packages/core/src/execution/` | Paper fills, open positions, SL/TP monitor |

### Auto-trading rules

- **Approved** (score ≥ 7.5 + risk gate passed) → paper entry on the same scan
- **Watchlist** (5.0–7.5) → recorded only; bot does not trade
- **Rejected** or risk blocked → dropped
- **Kill switch** (`POST /api/bot/pause`) → no new entries; position monitor still closes open trades
- **Cooldown** → no re-entry on the same instrument + direction within `review.duplicateCooldownMinutes`

### Scoring rubric

| Component | Weight | Basis |
|---|---|---|
| Signal strength | 30% | Triggered detectors + agreement bonus |
| Trend alignment | 20% | Higher-timeframe trend |
| Risk/reward quality | 20% | Computed R:R to TP1 |
| Risk gate margin | 15% | Headroom against limits |
| News/context | 15% | Sentiment vs direction |

---

## Getting started

Requires Node.js ≥ 20.11 and Docker (for Postgres).

```bash
npm install
cp .env.example .env

npm run db:up
npm run db:migrate
npm run db:seed

npm run pipeline:once      # one full pass
```

Run the three processes:

```bash
npm run dev:worker         # 24/7 scanner + paper bot
npm run dev:api            # HTTP API on 127.0.0.1:4000
npm run dev:dashboard      # bot dashboard on http://localhost:3000
```

Dashboard routes: **Bot** (home), **Trades**, **Positions**, **Ideas**, **Watchlist**, **Settings**.

### Other commands

```bash
npm test
npm run typecheck
npm run backtest -- --days 7 --forward-hours 72
npm run db:down
```

---

## Configuration

Thresholds live in `packages/core/src/config/default.ts`. Paper execution settings:

```ts
execution: {
  mode: 'paper',
  autoDecisions: ['approved'],
  slippageBps: 5,
  feeBps: 10,
  paused: false,
}
```

Account size from **$10** upward via Settings or `PUT /api/portfolio`.

### Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres (port 5433 default) |
| `BINANCE_BASE_URL` | Public REST for market data (no key) |
| `NEWS_PROVIDER` | `stub` or `cryptopanic` |
| `EXECUTION_PAUSED` | Documented; runtime pause via API/dashboard |

---

## Paper only — no live credentials

- v1 uses **simulated fills** with configurable slippage and fees
- No Binance API secrets, signed endpoints, or ccxt
- `packages/core/tests/no-live-credentials.test.ts` fails the build on live-trading patterns
- Live trading (real money) is a future phase requiring futures/margin support

---

## Backtesting

```bash
npm run backtest -- --days 7 --forward-hours 72 --persist
```

Replay re-runs stages 2–6 over stored snapshots. Separate from the paper bot ledger.

---

## Layout

```
packages/core/
  src/execution/        paper executor + position monitor
  src/pipeline/         orchestrator (terminal: submitEntry)
  src/stages/           scanner through scoring
  src/db/migrations/    includes 004_execution.sql
apps/worker/            24/7 bot process
apps/api/               bot status, trades, positions, pause/resume
apps/dashboard/         Bot home, Trades, Positions, Watchlist, Settings
```

## Operational notes

- Worker runs position monitor **before** each scan (SL/TP exits)
- Portfolio and open positions are **bot-maintained** after migration 004
- Pause only stops new entries; open positions still exit automatically
- Pending watchlist review items expire after `review.pendingTtlMinutes` (legacy audit)
