-- Runtime-adjustable minimum score for auto-trading approved memos.

ALTER TABLE bot_runtime ADD COLUMN IF NOT EXISTS approve_threshold DOUBLE PRECISION NOT NULL DEFAULT 7.5;
ALTER TABLE bot_runtime DROP CONSTRAINT IF EXISTS bot_runtime_approve_threshold_check;
ALTER TABLE bot_runtime ADD CONSTRAINT bot_runtime_approve_threshold_check
  CHECK (approve_threshold > 0 AND approve_threshold <= 10);
