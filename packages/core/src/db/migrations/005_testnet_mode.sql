-- Allow testnet execution mode on orders and persist runtime mode on bot_runtime.

ALTER TABLE execution_orders DROP CONSTRAINT IF EXISTS execution_orders_mode_check;
ALTER TABLE execution_orders ADD CONSTRAINT execution_orders_mode_check
  CHECK (mode IN ('paper', 'testnet', 'live'));

ALTER TABLE bot_runtime ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'paper';
ALTER TABLE bot_runtime DROP CONSTRAINT IF EXISTS bot_runtime_execution_mode_check;
ALTER TABLE bot_runtime ADD CONSTRAINT bot_runtime_execution_mode_check
  CHECK (execution_mode IN ('paper', 'testnet', 'live'));
