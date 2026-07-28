-- Stage-by-stage audit trail. Nothing is ever deleted: blocked plans and
-- rejected memos are the raw material for backtesting the scoring rubric.

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ,
  duration_ms   INTEGER,
  mode          TEXT NOT NULL DEFAULT 'live',
  stats         JSONB,
  errors        JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stage 1
CREATE TABLE IF NOT EXISTS market_snapshots (
  id                     BIGSERIAL PRIMARY KEY,
  run_id                 BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  instrument             TEXT NOT NULL,
  correlation_group      TEXT NOT NULL,
  captured_at            TIMESTAMPTZ NOT NULL,
  price                  DOUBLE PRECISION NOT NULL,
  volume_ratio           DOUBLE PRECISION NOT NULL,
  higher_timeframe_trend TEXT NOT NULL,
  news_sentiment         DOUBLE PRECISION NOT NULL,
  setup_candidate        BOOLEAN NOT NULL,
  -- Full MarketSnapshot including candles, so a replay run sees exactly what
  -- the live run saw.
  payload                JSONB NOT NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_instrument_time ON market_snapshots (instrument, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON market_snapshots (captured_at DESC);

-- Stage 2
CREATE TABLE IF NOT EXISTS signal_candidates (
  id                  BIGSERIAL PRIMARY KEY,
  snapshot_id         BIGINT NOT NULL REFERENCES market_snapshots(id) ON DELETE CASCADE,
  run_id              BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  instrument          TEXT NOT NULL,
  captured_at         TIMESTAMPTZ NOT NULL,
  direction           TEXT NOT NULL,
  triggered_count     INTEGER NOT NULL,
  agreement_count     INTEGER NOT NULL,
  disagreement_count  INTEGER NOT NULL,
  counter_trend       BOOLEAN NOT NULL,
  detectors           JSONB NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_instrument_time ON signal_candidates (instrument, captured_at DESC);

-- Stage 3
CREATE TABLE IF NOT EXISTS trade_plans (
  id                 BIGSERIAL PRIMARY KEY,
  signal_id          BIGINT NOT NULL REFERENCES signal_candidates(id) ON DELETE CASCADE,
  run_id             BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  instrument         TEXT NOT NULL,
  direction          TEXT NOT NULL,
  entry_low          DOUBLE PRECISION NOT NULL,
  entry_high         DOUBLE PRECISION NOT NULL,
  reference_entry    DOUBLE PRECISION NOT NULL,
  stop_loss          DOUBLE PRECISION NOT NULL,
  targets            JSONB NOT NULL,
  risk_reward_ratio  DOUBLE PRECISION NOT NULL,
  invalidation       TEXT NOT NULL,
  timeframe          TEXT NOT NULL,
  confidence         DOUBLE PRECISION NOT NULL,
  payload            JSONB NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plans_instrument_time ON trade_plans (instrument, created_at DESC);

-- Stage 4. Rows are written for blocked plans too; that is the point.
CREATE TABLE IF NOT EXISTS risk_gate_results (
  id                BIGSERIAL PRIMARY KEY,
  plan_id           BIGINT NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  run_id            BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  overall_pass      BOOLEAN NOT NULL,
  aggregate_margin  DOUBLE PRECISION NOT NULL,
  quantity          DOUBLE PRECISION NOT NULL,
  notional          DOUBLE PRECISION NOT NULL,
  risk_amount       DOUBLE PRECISION NOT NULL,
  payload           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_results_plan ON risk_gate_results (plan_id);

CREATE TABLE IF NOT EXISTS risk_checks (
  id             BIGSERIAL PRIMARY KEY,
  gate_result_id BIGINT NOT NULL REFERENCES risk_gate_results(id) ON DELETE CASCADE,
  check_name     TEXT NOT NULL,
  pass           BOOLEAN NOT NULL,
  detail         TEXT NOT NULL,
  value_checked  DOUBLE PRECISION NOT NULL,
  limit_value    DOUBLE PRECISION NOT NULL,
  margin         DOUBLE PRECISION NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_risk_checks_result ON risk_checks (gate_result_id);

-- Stage 6
CREATE TABLE IF NOT EXISTS decision_memos (
  id           BIGSERIAL PRIMARY KEY,
  plan_id      BIGINT NOT NULL REFERENCES trade_plans(id) ON DELETE CASCADE,
  run_id       BIGINT REFERENCES pipeline_runs(id) ON DELETE SET NULL,
  instrument   TEXT NOT NULL,
  direction    TEXT NOT NULL,
  score        DOUBLE PRECISION NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('approved', 'watchlist', 'rejected')),
  rationale    TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memos_decision_score ON decision_memos (decision, score DESC);
CREATE INDEX IF NOT EXISTS idx_memos_created_at ON decision_memos (created_at DESC);

-- Stage 5. A memo only reaches a human through this table.
CREATE TABLE IF NOT EXISTS review_queue (
  memo_id      BIGINT PRIMARY KEY REFERENCES decision_memos(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'acknowledged', 'dismissed', 'expired')),
  reviewed_by  TEXT,
  reviewed_at  TIMESTAMPTZ,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue (status, created_at DESC);

-- Immutable record of what a human did. Written on every review action so an
-- acknowledgement can never be attributed to the system.
CREATE TABLE IF NOT EXISTS review_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  memo_id     BIGINT NOT NULL REFERENCES decision_memos(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  notes       TEXT,
  memo_score  DOUBLE PRECISION NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_review_audit_memo ON review_audit_log (memo_id, created_at DESC);

-- Portfolio state the risk gate reads. Maintained by the operator, not by the
-- engine: the engine has no way to open a position.
CREATE TABLE IF NOT EXISTS portfolio_state (
  id                BIGSERIAL PRIMARY KEY,
  equity            DOUBLE PRECISION NOT NULL,
  peak_equity       DOUBLE PRECISION NOT NULL,
  day_realised_pnl  DOUBLE PRECISION NOT NULL DEFAULT 0,
  as_of             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portfolio_as_of ON portfolio_state (as_of DESC);

CREATE TABLE IF NOT EXISTS open_positions (
  id                BIGSERIAL PRIMARY KEY,
  instrument        TEXT NOT NULL,
  correlation_group TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  quantity          DOUBLE PRECISION NOT NULL,
  entry_price       DOUBLE PRECISION NOT NULL,
  stop_loss         DOUBLE PRECISION NOT NULL,
  notional          DOUBLE PRECISION NOT NULL,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_positions_open ON open_positions (instrument) WHERE closed_at IS NULL;

-- Cached news so a 5-minute pipeline tick does not hammer a 15-minute source.
CREATE TABLE IF NOT EXISTS news_cache (
  id            BIGSERIAL PRIMARY KEY,
  instrument    TEXT NOT NULL,
  provider      TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload       JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_cache_instrument ON news_cache (instrument, fetched_at DESC);
