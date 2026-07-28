# Cursor Build Prompt — 24/7 Trade Signal & Decision Engine

> **Assumptions made (edit before pasting into Cursor if wrong):**
> - Stack: Node.js + TypeScript backend, Postgres for storage, a simple Next.js dashboard for the human review step.
> - Market: crypto (Binance public API + a news API), since it's the easiest to run 24/7 without a broker session/market-hours problem. Swap for your actual market (equities, forex, PSX, etc.) by changing the data-source section.
> - This is a **signal and decision-support system, not an auto-executor**. It never places trades. Step 5 (human review) is a hard gate, not a formality — the code should make it structurally impossible to skip.

Copy everything below the line into Cursor as your project prompt / first instruction.

---

## Project: 24/7 Market Scanner & Trade Decision Engine

Build a system that runs continuously, scans markets, detects signals, builds a trade plan for each signal, runs the plan through a risk gate, and produces a scored decision memo for human approval. **The system never auto-executes trades.** Its only output is a ranked list of memos a human reads and acts on manually (or approves for a separate, explicitly-authorized execution layer later).

### High-level pipeline (build in this order, each stage a separate module with a clean interface)

```
[1] Market Scanner → [2] Signal Detector → [3] Trade Plan Builder → [4] Risk Gate → [5] Human Review Queue → [6] Decision Memo + Score
```

Each stage should take a typed input and return a typed output so the pipeline is testable stage-by-stage, and so any stage can reject/short-circuit the item (e.g., risk gate blocks it before it ever reaches a human).

---

### Stage 1 — Market Scanner

Responsible for pulling raw market state on a schedule (e.g., every 1–5 min for price/volume, every 15 min for news).

Collect per instrument:
- **Price**: current, OHLCV candles across multiple timeframes (e.g., 15m, 1h, 4h, 1D)
- **Volume**: current vs. rolling average, volume spikes
- **News**: recent headlines/events tagged to the instrument, with a simple sentiment score
- **Trend context**: moving averages (e.g., 20/50/200), higher-timeframe trend direction
- **Setup candidates**: flag instruments touching key levels (support/resistance, VWAP, recent high/low)

Output: a `MarketSnapshot` object per instrument, timestamped, stored to DB (for backtesting/audit later).

### Stage 2 — Signal Detector

Consumes `MarketSnapshot`s and runs a set of independent detectors, each returning a sub-score and rationale:

- **Breakout detector** — price clearing a defined range/level with volume confirmation
- **Pullback detector** — retracement to a moving average / fib level within an established trend
- **Momentum detector** — RSI/MACD or similar showing strengthening move
- **Trend contribution** — how aligned the setup is with the higher-timeframe trend (counter-trend setups scored lower or flagged)
- **Reversal detector** — exhaustion patterns, divergence, key-level rejection

Each detector returns:
```ts
{
  name: string,
  triggered: boolean,
  strength: number,      // 0–1
  rationale: string,     // human-readable "why"
}
```

Combine into a `SignalCandidate` only if at least one detector triggers. Store which detectors fired — this becomes input to the final score.

### Stage 3 — Trade Plan Builder

For each `SignalCandidate`, build a concrete, falsifiable plan:

```ts
{
  instrument: string,
  direction: "long" | "short",
  entryZone: { low: number, high: number },
  stopLoss: number,
  targets: number[],        // profit targets, e.g. TP1/TP2/TP3
  riskRewardRatio: number,  // computed, not guessed
  invalidation: string,     // what price action/condition kills this idea
  timeframe: string,        // the timeframe this plan is built for
  confidence: number,       // 0–1, model's own confidence pre-risk-gate
  timestamp: string,
}
```

Risk/reward must be computed from entry/stop/target, not asserted. Invalidation should be a specific, checkable condition (e.g., "4h close below 61200"), not a vague phrase.

### Stage 4 — Risk Gate (hard pass/fail, runs after every plan, before anything reaches a human)

This stage is a strict gate: **any failed check blocks the trade plan from proceeding**, full stop. Log every check's result (pass/fail + numbers) for audit, even on plans that get blocked.

Checks, each its own function:

1. **Position size check** — proposed size vs. account risk-per-trade limit (e.g., ≤1–2% of account equity at stop-loss distance)
2. **Exposure limit check** — total open + proposed exposure per instrument, per sector/correlated group, and portfolio-wide, vs. configured caps
3. **Drawdown check** — current account drawdown vs. max allowed; if breached, block all new plans regardless of score
4. **Volatility check** — instrument's current ATR/volatility vs. its own historical norm; block or downsize if abnormally volatile (avoids sizing a "normal" stop into a currently-chaotic instrument)
5. **Max loss check** — worst-case loss if stop is hit vs. absolute per-trade and per-day loss ceilings

```ts
type RiskCheckResult = {
  check: string,
  pass: boolean,
  detail: string,
  valueChecked: number,
  limit: number,
};

type RiskGateResult = {
  overallPass: boolean,
  checks: RiskCheckResult[],
};
```

If `overallPass` is false, the plan is tagged `rejected` and routed straight to the rejected list — it does not go to human review.

### Stage 5 — Human Review Queue (non-negotiable gate)

Every plan that **passes** the risk gate lands here — not executed, not "auto-approved," just queued with its full memo for a person to read. Build this as an actual UI list/dashboard (or at minimum a structured CLI/API output), not a log line, since it's the point where a human must consciously act.

Design constraint for Cursor: there should be no code path from "signal detected" to "trade executed" that doesn't pass through a screen a human looks at and clicks "approved." Do not build any auto-execution/order-placement code as part of this project.

### Stage 6 — Decision Memo + Score

Every processed candidate — approved, watchlist, or rejected — gets a final memo:

```ts
{
  instrument: string,
  direction: string,
  score: number,            // 0–10, see scoring rubric below
  decision: "approved" | "watchlist" | "rejected",
  tradePlan: TradePlan,
  signalsFired: SignalCandidate["detectors"],
  riskGateResult: RiskGateResult,
  rationale: string,        // 2-4 sentence plain-English summary
  timestamp: string,
}
```

**Scoring rubric (0–10), combine into one weighted score:**

| Component | Weight | Basis |
|---|---|---|
| Signal strength | 30% | avg strength of triggered detectors, weighted by how many independently agree |
| Trend alignment | 20% | is this with or against the higher-timeframe trend |
| Risk/reward quality | 20% | computed R:R from trade plan (e.g., <1.5 scores low, 3+ scores high) |
| Risk gate margin | 15% | how much headroom vs. limits (a check that barely passes scores lower than one with room to spare) |
| News/context confirmation | 15% | does news/sentiment support or contradict the technical signal |

**Decision thresholds (make these configurable, not hardcoded):**
- Score ≥ 7.5 **and** risk gate passed → `approved`
- Score 5–7.49 **and** risk gate passed → `watchlist`
- Risk gate failed, **or** score < 5 → `rejected`

Output: a single ranked list, highest score first, so the top of the list is always "the best thing to look at right now." Approved items surfaced first, then watchlist, then rejected (rejected items kept for audit/backtesting, not deleted).

---

### Non-functional requirements

- **Runs continuously** (cron/scheduler or a long-running worker process; don't build this as a one-shot script)
- **Everything is logged and stored** — every snapshot, every signal, every risk check, every memo, with timestamps, so you can backtest the scoring later against what actually happened
- **Config-driven limits** — all thresholds (risk %, exposure caps, drawdown limit, score cutoffs) live in one config file/table, not scattered magic numbers
- **No auto-execution** — this system's only output is information for a human; do not wire it to any broker/exchange order-placement API
- **Modular/testable** — each of the 6 stages should be independently unit-testable with mock inputs

### Suggested build order for Cursor

1. Scaffold project structure + config + DB schema for snapshots/signals/plans/memos
2. Build Stage 1 (scanner) against one data source first, get it storing snapshots on a schedule
3. Build Stage 2 (detectors) against stored snapshots, one detector at a time
4. Build Stage 3 (trade plan builder)
5. Build Stage 4 (risk gate) with all 5 checks and full audit logging
6. Build Stage 6 scoring logic
7. Build Stage 5 (human review dashboard) last, once there's real data flowing to review
8. Add a simple backtest/replay mode using stored historical snapshots to sanity-check the scoring rubric before trusting it live

Ask me before writing code: what market/instruments, what data source/API keys I have available, and what account size/risk % to use as defaults for the risk gate.
