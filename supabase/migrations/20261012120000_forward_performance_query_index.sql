-- Supports the exact filter and order used by /api/admin/forward-performance.
-- The existing forward indexes lead with cohort/version columns, so they do
-- not efficiently serve the dashboard's chronological pagination query.
create index if not exists idx_signal_history_forward_performance_v2
on public.signal_history (scanned_at)
where is_lifecycle_primary is true
  and strategy_qualified is true
  and qualification_source = 'LIVE_AT_SIGNAL'
  and market_session_status = 'LIVE_REGULAR_SESSION';
