-- A 5-minute scan interval re-derives the same setup from the same candles for
-- as long as it remains valid, so without de-duplication one idea would enqueue
-- hundreds of near-identical memos a day and a dismissed idea would reappear
-- minutes later. Two extra terminal states let the queue hold one live item per
-- instrument+direction while still keeping every memo for audit and replay.
--
--   superseded — a fresher memo for the same idea replaced this pending one
--   suppressed — never shown, because a human decided on this idea recently

ALTER TABLE review_queue DROP CONSTRAINT IF EXISTS review_queue_status_check;
ALTER TABLE review_queue ADD CONSTRAINT review_queue_status_check
  CHECK (status IN ('pending', 'acknowledged', 'dismissed', 'expired', 'superseded', 'suppressed'));

-- Records which memo replaced this one, so the audit trail survives superseding.
ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS superseded_by BIGINT
  REFERENCES decision_memos(id) ON DELETE SET NULL;

-- The dedup lookup is "latest queue row for this instrument+direction", which
-- reads decision_memos by those two columns and orders by recency.
CREATE INDEX IF NOT EXISTS idx_memos_instrument_direction
  ON decision_memos (instrument, direction, created_at DESC);
