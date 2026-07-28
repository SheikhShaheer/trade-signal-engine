-- Replay results. Kept separate from live memos so a backtest can never be
-- mistaken for something a human was asked to review.

CREATE TABLE IF NOT EXISTS backtest_runs (
  id           BIGSERIAL PRIMARY KEY,
  label        TEXT NOT NULL,
  config       JSONB NOT NULL,
  from_time    TIMESTAMPTZ NOT NULL,
  to_time      TIMESTAMPTZ NOT NULL,
  summary      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_results (
  id             BIGSERIAL PRIMARY KEY,
  backtest_id    BIGINT NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  snapshot_id    BIGINT NOT NULL REFERENCES market_snapshots(id) ON DELETE CASCADE,
  instrument     TEXT NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL,
  direction      TEXT,
  score          DOUBLE PRECISION,
  decision       TEXT,
  -- 'target' | 'stop' | 'open' | 'no-data': what happened first in the
  -- snapshots that came after this one.
  outcome        TEXT NOT NULL,
  realised_r     DOUBLE PRECISION,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backtest_results_run ON backtest_results (backtest_id, score DESC);
