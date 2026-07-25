alter table public.signal_history
  add column if not exists strategy_version text,
  add column if not exists strategy_classification text,
  add column if not exists strategy_qualified boolean,
  add column if not exists qualification_reasons jsonb,
  add column if not exists qualification_snapshot jsonb,
  add column if not exists shadow_mode boolean,
  add column if not exists planned_risk_pct numeric,
  add column if not exists planned_risk_reward numeric,
  add column if not exists last_walked_through date,
  add column if not exists premium_stop_loss_pct numeric,
  add column if not exists planned_account_risk_pct numeric,
  add column if not exists strategy_assigned_at timestamptz,
  add column if not exists qualification_source text,
  add column if not exists experiment_cohort text,
  add column if not exists experiment_enrolled_at timestamptz;

comment on column public.signal_history.planned_risk_pct is
  'Deprecated legacy field: historically stored option premium stop percentage, not account allocation risk.';
comment on column public.signal_history.premium_stop_loss_pct is
  'Fractional loss in option premium at the planned stop (for example 0.50 = 50%).';
comment on column public.signal_history.planned_account_risk_pct is
  'Fraction of account equity allocated as maximum loss; null until position sizing is implemented.';
comment on column public.signal_history.qualification_source is
  'LIVE_AT_SIGNAL for prospective observations; HISTORICAL_BACKFILL for retrospective labels.';

update public.signal_history
set premium_stop_loss_pct = planned_risk_pct
where premium_stop_loss_pct is null
  and planned_risk_pct is not null;

update public.signal_history
set
  strategy_assigned_at = coalesce(strategy_assigned_at, now()),
  qualification_source = coalesce(qualification_source, 'HISTORICAL_BACKFILL'),
  experiment_cohort = case
    when strategy_qualified is true then coalesce(
      experiment_cohort,
      'historical_' || to_char(scanned_at at time zone 'America/New_York', 'YYYY-MM')
    )
    else null
  end,
  experiment_enrolled_at = case
    when strategy_qualified is true then coalesce(experiment_enrolled_at, now())
    else null
  end
where strategy_version is not null;

alter table public.signal_history
  add constraint signal_history_qualification_source_check
  check (
    qualification_source is null
    or qualification_source in ('LIVE_AT_SIGNAL', 'HISTORICAL_BACKFILL')
  ) not valid;

alter table public.signal_history
  add constraint signal_history_strategy_classification_check
  check (
    strategy_classification is null
    or strategy_classification in (
      'QUALIFIED_V1',
      'PUT_RESEARCH',
      'QUICK_CALL_RESEARCH',
      'OTHER_RESEARCH'
    )
  ) not valid;

alter table public.signal_history
  validate constraint signal_history_qualification_source_check;
alter table public.signal_history
  validate constraint signal_history_strategy_classification_check;

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
