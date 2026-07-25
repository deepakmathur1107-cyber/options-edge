-- Stage 4 of 4 (indexes). Plain CREATE INDEX, not CONCURRENTLY — Supabase
-- MCP's apply_migration wraps each call in a transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block
-- (confirmed by attempting it directly and receiving Postgres error
-- 25001). Run during low-traffic hours as the best available mitigation
-- given this tooling constraint.
create index if not exists idx_signal_history_pending_resolution_primary
  on public.signal_history (resolve_attempts nulls first, scanned_at)
  where outcome is null
    and resolved_at is null
    and is_lifecycle_primary is true;

create index if not exists idx_signal_history_forward_experiment
  on public.signal_history (strategy_version, experiment_cohort, scanned_at)
  where qualification_source = 'LIVE_AT_SIGNAL'
    and strategy_qualified is true
    and is_lifecycle_primary is true;
