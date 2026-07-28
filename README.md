# 24/7 Market Scanner & Trade Decision Engine

A continuously-running system that scans crypto markets, detects signals, builds a concrete trade plan for each one, forces every plan through a hard risk gate, and produces a scored decision memo for a human to read.

**It never places trades.** Its only output is a ranked list of memos. There is no broker integration, no order-placement code, and no exchange credential anywhere in the repository — [a test enforces this](#the-no-auto-execution-guarantee) so the property survives future changes.

---

## Pipeline

```
[1] Market Scanner → [2] Signal Detector → [3] Trade Plan Builder → [4] Risk Gate → [5] Human Review Queue → [6] Decision Memo + Score
```

Each stage takes a typed input and returns a typed output, so any stage can be tested in isolation with mock inputs and any stage can reject an item before it reaches the next one. Nothing is deleted along the way: blocked plans and rejected memos are the raw material for backtesting the scoring rubric.

| Stage | Module | What it does |
|---|---|---|
| 1. Scanner | `packages/core/src/stages/scanner.ts` | Pulls OHLCV across 15m/1h/4h/1D, volume vs. rolling average, moving averages, higher-timeframe trend, key levels and news. Emits a `MarketSnapshot`. |
| 2. Detectors | `packages/core/src/stages/detectors/` | Five independent detectors (breakout, pullback, momentum, trend, reversal), each returning `{ triggered, strength, rationale, evidence }`. Assembles a `SignalCandidate`. |
| 3. Planner | `packages/core/src/stages/planner.ts` | Builds entry zone, stop, targets, **computed** R:R and a checkable invalidation condition. Rejects plans that do not meet the minimum R:R. |
| 4. Risk gate | `packages/core/src/stages/risk-gate/` | Position size, exposure (instrument / correlated group / portfolio), drawdown, volatility regime, and absolute max-loss checks. Any failure blocks the plan. |
| 5. Review queue | `apps/dashboard` + `apps/api` | The only terminal action in the pipeline. A person reads the memo and records a decision with a written reason. De-duplicates repeats of the same idea — see [below](#one-idea-one-queue-entry). |
| 6. Scoring | `packages/core/src/stages/scoring.ts` | Weighted 0–10 score with a per-component breakdown, then the configured decision thresholds. |

### Scoring rubric

| Component | Weight | Basis |
|---|---|---|
| Signal strength | 30% | Mean strength of triggered detectors, lifted by how many independently agree |
| Trend alignment | 20% | With or against the higher-timeframe trend (flat is neutral, not a penalty) |
| Risk/reward quality | 20% | Computed R:R to TP1, scored across a configurable band |
| Risk gate margin | 15% | Headroom against limits — a check that barely passes scores lower than one with room to spare |
| News/context | 15% | Whether sentiment supports or contradicts the technical direction (no news is neutral) |

Decisions, all configurable in `packages/core/src/config/default.ts`:

- score ≥ 7.5 **and** risk gate passed → `approved`
- score 5.0–7.49 **and** risk gate passed → `watchlist`
- risk gate failed **or** score < 5.0 → `rejected`

A failed risk gate always rejects, regardless of score.

### One idea, one queue entry

A setup that stays valid is re-derived from the same candles on every scan. At a five-minute interval that is roughly 288 memos a day for a single instrument in a single direction, and an idea you dismissed reappears minutes later. So instrument + direction is treated as the identity of an idea, and `review_queue` holds at most one live entry per idea:

| Situation | Status | Effect |
|---|---|---|
| A human acknowledged or dismissed this idea within `review.duplicateCooldownMinutes` (2h) | `suppressed` | Never shown. A decision is not re-litigated by the next scan. |
| An entry for this idea is already pending | `superseded` | Replaced by the fresher memo, so the levels on screen are current. |
| Neither | `pending` | Queued normally. |

Every memo is still written either way — the status only decides whether a human is asked. Superseded and suppressed memos stay queryable for audit and backtesting, and the run log reports the counts:

```
pipeline run complete ... queued=0 superseded=0 suppressed=2
```

For the same reason, the ranked list collapses to the freshest memo per idea. `GET /api/memos?history=true` returns every repeat when you want the raw history.

Two details worth knowing if you change this code:

- Expiry is not a decision. A `pending` item that timed out means nobody looked, so the next scan is free to queue the idea again.
- The check asks "was this decided recently?" and "is anything pending?" independently. Reading only the most recent queue row means the `suppressed` row this logic just wrote hides the human decision behind it, and every second repeat gets back into the queue.

---

## Getting started

Requires Node.js ≥ 20.11 and Docker (for Postgres).

```bash
npm install
cp .env.example .env       # defaults work as-is; no API keys needed

npm run db:up              # Postgres on host port 5433
npm run db:migrate         # create the schema
npm run db:seed            # seed the portfolio row the risk gate reads

npm run pipeline:once      # one full pass, prints what happened and why
```

Then run the three processes, each in its own terminal:

```bash
npm run dev:worker         # the 24/7 scanner
npm run dev:api            # HTTP API on 127.0.0.1:4000
npm run dev:dashboard      # review queue on http://localhost:3000
```

`npm run pipeline:once` is the fastest way to confirm a working install. It prints the per-stage counts, then a line per instrument explaining exactly why it did not reach the review queue — no signal, plan rejected, risk gate blocked, or score below the cutoff.

### Other commands

```bash
npm test                   # 158 unit tests, no database or network required
npm run typecheck          # project-wide TypeScript build
npm run backtest -- --days 7 --forward-hours 72   # replay stored snapshots
npm run db:down            # stop Postgres
```

---

## Configuration

Every threshold in the system lives in `packages/core/src/config/default.ts` — risk percentages, exposure caps, drawdown limit, volatility band, detector parameters, score weights and decision cutoffs. Stages read limits from that object only; a magic number inside a stage is a bug.

The defaults are a $10,000 account risking 1% per trade with a 10% maximum drawdown, scanning eight crypto majors. Account size can be set as low as **$10** in the dashboard Settings page (or by seeding `portfolio_state`); max-loss ceilings are percentages of equity so the same rules apply at every size.

The config is validated on load by `packages/core/src/config/index.ts`, which also runs cross-field coherence checks that a per-field schema cannot express — a candle limit too small for the longest moving average, an approval threshold below the watchlist threshold, exposure caps that contradict each other, or a target multiple that could never clear the minimum R:R. These fail at startup rather than producing quietly wrong signals.

One relationship worth understanding before you tighten anything: **notional exposure caps must be read against the sizing maths.** Position size is derived from risk, so risking 1% of equity behind a 2% stop implies a 50% notional position. Caps tighter than that silently block almost every valid plan instead of catching real over-concentration.

### Environment

`.env` holds only deployment concerns, never trading limits:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (host port 5433 by default, to avoid colliding with a local install) |
| `BINANCE_BASE_URL` | Public REST base URL. No key: the client only touches unauthenticated endpoints |
| `NEWS_PROVIDER` | `stub` (offline, deterministic) or `cryptopanic` |
| `CRYPTOPANIC_API_KEY` | Required only when `NEWS_PROVIDER=cryptopanic` |
| `API_PORT` / `API_HOST` | API bind address, `127.0.0.1` by default |
| `REVIEWER_NAME` | Stamped onto review decisions in the audit log |

Migrations run automatically when the worker, the API or `npm run db:migrate` starts, and they take a Postgres advisory lock so overlapping starts serialise instead of one of them dying on a duplicate `schema_migrations` row.

The default news provider is a deterministic offline stub, so the pipeline is fully runnable without any API key. It generates a stable headline set per instrument per hour, which also means replaying a window twice produces the same news context. **It is not a market signal** — swap in a real provider before trusting the news component of any score.

---

## The no-auto-execution guarantee

The design constraint is that no code path leads from "signal detected" to "trade executed". It is enforced structurally rather than by convention:

- The pipeline's terminal action is `review.enqueue`. No stage exists downstream of it.
- `MarketDataProvider` exposes exactly three methods: `getCandles`, `getLastPrice`, `assertSymbolSupported`. There is no interface in the codebase through which an order could be sent.
- The Binance client uses only public unauthenticated endpoints. There is no API secret, no request signing and no account endpoint.
- No database table can record an engine-initiated order. A memo's status changes only via `review_queue`, and every change writes a human actor into `review_audit_log`.
- Acknowledging a memo requires a written note, enforced by the API rather than the UI, so it cannot be bypassed by another client. There is no bulk approve.
- `packages/core/tests/no-auto-execution.test.ts` scans the entire source tree for order endpoints, order-placement calls, execution libraries, request signing and credential names, and fails the build on a match.

"Acknowledged" means a person read the memo and accepted it as actionable. Placing the trade, if they choose to, is a separate manual act.

---

## Backtesting the rubric

```bash
npm run backtest -- --days 7 --forward-hours 72 --persist
```

Replay re-runs stages 2–6 over stored snapshots, then walks forward candle by candle to see whether each plan's stop or first target came first. It reports hit rate and mean R by score bucket, plus the correlation between score and realised R.

Read it as a sanity check, not a P&L. There are no fees, no slippage, and no assumption that a human would have taken every trade. When a single candle spans both the stop and the target, the stop is assumed to have hit first — intrabar sequence is unknowable from OHLC, and the pessimistic assumption is the only one that cannot flatter the rubric.

**The score is a heuristic until this says otherwise.** Higher buckets should show a better hit rate and mean R than lower ones. If they do not, the weights need revisiting before the score is trusted. You need several days of accumulated snapshots before the output means anything.

---

## Layout

```
packages/core/          the whole engine as a library
  src/config/           every threshold, plus validation and coherence checks
  src/indicators/       pure indicator maths (SMA, EMA, RSI, MACD, ATR, VWAP, pivots)
  src/providers/        market data and news, behind read-only interfaces
  src/stages/           stages 1, 2, 3, 4 and 6
  src/pipeline/         orchestrator and the overlap-safe scheduler
  src/db/               schema, migrations and repositories
  src/backtest/         replay engine and CLI
  tests/                158 unit tests
apps/worker/            the long-running 24/7 process
apps/api/               HTTP API behind the dashboard
apps/dashboard/         Next.js review tool (multi-page: Overview, Review, Ideas, History, Settings)
```

## Operational notes

- The worker is a long-running process, not a cron one-shot. It survives transient provider and database failures, and shuts down cleanly on SIGINT/SIGTERM so an in-flight run is never left half-written.
- A tick that overruns causes the next one to be **skipped**, not queued. Two overlapping runs would double-count exposure against the same portfolio snapshot, and a backlog of stale ticks is worse than a gap.
- Portfolio state and open positions are maintained by the operator, in `portfolio_state` and `open_positions`. The engine only reads them — it has no way to open a position.
- Pending review items expire after `review.pendingTtlMinutes` (4 hours by default), so a stale plan cannot be approved against a market that has moved.
- The last kline from Binance is dropped on every fetch, because it is the candle still forming. Detectors treating it as closed would fire on incomplete information.
