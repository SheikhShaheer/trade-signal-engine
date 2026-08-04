-- Runtime signal timeframe and live mark-to-market on open positions.

ALTER TABLE bot_runtime ADD COLUMN IF NOT EXISTS signal_timeframe TEXT NOT NULL DEFAULT '4h';
ALTER TABLE bot_runtime DROP CONSTRAINT IF EXISTS bot_runtime_signal_timeframe_check;
ALTER TABLE bot_runtime ADD CONSTRAINT bot_runtime_signal_timeframe_check
  CHECK (signal_timeframe IN ('15m', '1h', '4h', '1d'));

ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS mark_price DOUBLE PRECISION;
ALTER TABLE open_positions ADD COLUMN IF NOT EXISTS unrealised_pnl DOUBLE PRECISION;
