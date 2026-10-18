-- Already applied via Supabase MCP, included for reference.
DROP INDEX IF EXISTS idx_signal_history_historical_spread_backfill;

CREATE INDEX IF NOT EXISTS idx_signal_history_historical_spread_backfill
  ON signal_history (scanned_at)
  WHERE is_lifecycle_primary = true
    AND outcome IS NOT NULL AND outcome != 'AMBIGUOUS'
    AND historical_shadow_spread_outcome IS NULL
    AND timeframe IN ('Swing (21–45 DTE)','LEAP (90–180 DTE)','Deep LEAP (180–365 DTE)');
