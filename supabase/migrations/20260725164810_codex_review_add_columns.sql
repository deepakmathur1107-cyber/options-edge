-- Stage 1 of 4 (columns only) — from Codex's codex/resolver-correctness
-- branch review, split into staged calls per Supabase MCP's transactional
-- tooling constraints (CREATE INDEX CONCURRENTLY can't run in a
-- transaction, so indexes are isolated to their own later call).
alter table public.signal_history
  add column if not exists premium_stop_loss_pct numeric,
  add column if not exists planned_account_risk_pct numeric,
  add column if not exists strategy_assigned_at timestamptz,
  add column if not exists qualification_source text,
  add column if not exists experiment_cohort text,
  add column if not exists experiment_enrolled_at timestamptz;

comment on column public.signal_history.planned_risk_pct is
  'Deprecated legacy field: historically stored option premium stop percentage, not account allocation risk. Use premium_stop_loss_pct instead.';
comment on column public.signal_history.premium_stop_loss_pct is
  'Fractional loss in option premium at the planned stop (for example 0.50 = 50%).';
comment on column public.signal_history.planned_account_risk_pct is
  'Fraction of account equity allocated as maximum loss; null until position sizing is implemented.';
comment on column public.signal_history.qualification_source is
  'LIVE_AT_SIGNAL for prospective observations; HISTORICAL_BACKFILL for retrospective labels.';
