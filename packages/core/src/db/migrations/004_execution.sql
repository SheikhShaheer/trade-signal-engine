-- Paper trading execution: orders, fills, events, and bot runtime state.
-- The engine opens and closes positions automatically from approved memos.

CREATE TABLE IF NOT EXISTS execution_orders (
  id                BIGSERIAL PRIMARY KEY,
  memo_id           BIGINT NOT NULL REFERENCES decision_memos(id),
  mode              TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  instrument        TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  quantity          DOUBLE PRECISION NOT NULL,
  requested_price   DOUBLE PRECISION NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'rejected', 'cancelled')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_orders_memo ON execution_orders (memo_id);
CREATE INDEX IF NOT EXISTS idx_execution_orders_created ON execution_orders (created_at DESC);

CREATE TABLE IF NOT EXISTS execution_fills (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT NOT NULL REFERENCES execution_orders(id),
  price             DOUBLE PRECISION NOT NULL,
  quantity          DOUBLE PRECISION NOT NULL,
  fee               DOUBLE PRECISION NOT NULL DEFAULT 0,
  fill_type         TEXT NOT NULL CHECK (fill_type IN ('entry', 'exit')),
  filled_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_fills_order ON execution_fills (order_id);

CREATE TABLE IF NOT EXISTS execution_events (
  id                BIGSERIAL PRIMARY KEY,
  memo_id           BIGINT REFERENCES decision_memos(id),
  order_id          BIGINT REFERENCES execution_orders(id),
  position_id       BIGINT REFERENCES open_positions(id),
  event_type        TEXT NOT NULL,
  detail            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_execution_events_created ON execution_events (created_at DESC);

-- Single-row runtime state for the kill switch (API-toggleable).
CREATE TABLE IF NOT EXISTS bot_runtime (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  paused            BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO bot_runtime (id, paused) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

-- Extend open_positions for bot-managed trades.
ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS memo_id BIGINT REFERENCES decision_memos(id);
ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS order_id BIGINT REFERENCES execution_orders(id);
ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS take_profit DOUBLE PRECISION;
ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'bot';
CREATE INDEX IF NOT EXISTS idx_positions_bot_open ON open_positions (instrument, direction) WHERE closed_at IS NULL AND source = 'bot';
