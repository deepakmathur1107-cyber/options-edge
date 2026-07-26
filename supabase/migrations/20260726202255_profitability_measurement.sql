alter table public.signal_history
  add column if not exists estimated_entry_price numeric,
  add column if not exists estimated_exit_price numeric,
  add column if not exists estimated_entry_slippage_bps integer,
  add column if not exists estimated_exit_slippage_bps integer,
  add column if not exists estimated_fees_per_contract numeric,
  add column if not exists gross_pnl_pct numeric,
  add column if not exists estimated_net_pnl_pct numeric,
  add column if not exists realized_r_multiple numeric,
  add column if not exists max_favorable_excursion_pct numeric,
  add column if not exists max_adverse_excursion_pct numeric,
  add column if not exists walk_max_option_high numeric,
  add column if not exists walk_min_option_low numeric,
  add column if not exists holding_minutes bigint,
  add column if not exists measurement_version text,
  add column if not exists shadow_strategy_assignments jsonb;

comment on column public.signal_history.estimated_net_pnl_pct is
  'Execution-adjusted estimated return after modeled entry/exit slippage and one-contract round-trip fees.';
comment on column public.signal_history.realized_r_multiple is
  'Estimated net P&L divided by planned one-contract stop risk. Forward measurement only.';
comment on column public.signal_history.shadow_strategy_assignments is
  'Immutable shadow-only experimental assignments made at signal time; never changes live recommendations.';

alter table public.signal_history
  add constraint signal_history_execution_measurement_check
  check (
    (estimated_entry_price is null or estimated_entry_price > 0)
    and (estimated_exit_price is null or estimated_exit_price >= 0)
    and (estimated_entry_slippage_bps is null or estimated_entry_slippage_bps >= 0)
    and (estimated_exit_slippage_bps is null or estimated_exit_slippage_bps >= 0)
    and (estimated_fees_per_contract is null or estimated_fees_per_contract >= 0)
    and (walk_max_option_high is null or walk_max_option_high >= 0)
    and (walk_min_option_low is null or walk_min_option_low >= 0)
    and (holding_minutes is null or holding_minutes >= 0)
  ) not valid;

alter table public.signal_history
  validate constraint signal_history_execution_measurement_check;

create index if not exists idx_signal_history_forward_profitability
  on public.signal_history (experiment_cohort, resolved_at desc)
  where qualification_source = 'LIVE_AT_SIGNAL'
    and market_session_status = 'LIVE_REGULAR_SESSION'
    and strategy_qualified = true
    and is_lifecycle_primary = true;

alter table public.resolver_runs
  add column if not exists skip_reason text;
