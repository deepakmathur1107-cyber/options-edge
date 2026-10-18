-- Supports the new fetch ordering (resolve_attempts ASC NULLS FIRST, scanned_at
-- ASC) so the "untried rows before retried rows" query doesn't do a full sort
-- over the unresolved set every run. Same partial-index pattern as
-- idx_signal_history_unresolved_primary (already applied) — tiny, ~9k rows.
--
-- NOTE: my Supabase MCP connector is temporarily unavailable, so I couldn't
-- apply this one automatically like the last one. Run it via the Supabase
-- dashboard SQL editor (or let me know once it's back and I'll apply it).
-- The code fix works without this index — Postgres just does an in-memory
-- sort instead of an index scan, a small perf cost, not a correctness issue.

CREATE INDEX IF NOT EXISTS idx_signal_history_unresolved_attempts
  ON signal_history (resolve_attempts, scanned_at)
  WHERE outcome IS NULL AND is_lifecycle_primary = true;
