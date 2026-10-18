-- Already applied via Supabase MCP, included here for reference/repo history.
ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS shortened_hold_outcome text;

CREATE INDEX IF NOT EXISTS idx_signal_history_shortened_hold_backfill
  ON signal_history (scanned_at)
  WHERE is_lifecycle_primary = true
    AND outcome IS NOT NULL
    AND outcome != 'AMBIGUOUS'
    AND shortened_hold_outcome IS NULL
    AND timeframe = 'Swing (21–45 DTE)';
