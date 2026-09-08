alter table public.signal_history
  add column if not exists theta numeric,
  add column if not exists gamma numeric,
  add column if not exists vega numeric,
  add column if not exists weekly_trend text,
  add column if not exists support_level numeric,
  add column if not exists resistance_level numeric,
  add column if not exists support_distance_pct numeric,
  add column if not exists resistance_distance_pct numeric,
  add column if not exists expected_move_pct numeric,
  add column if not exists breakeven_required_pct numeric,
  add column if not exists breakeven_expected_move_ratio numeric,
  add column if not exists earnings_days_at_signal integer;

alter table public.iv_history
  add column if not exists source text,
  add column if not exists dte integer,
  add column if not exists captured_at timestamptz default now();

comment on table public.iv_history is
  'Forward-only daily IV observations. No synthetic historical backfill. Current collector uses a selected 21-45 DTE contract proxy and labels its source.';
comment on column public.signal_history.breakeven_expected_move_ratio is
  'Shadow-only: absolute underlying move required to breakeven divided by IV × sqrt(DTE/365).';
