alter table public.signal_history
  add column if not exists market_session_status text
    not null default 'UNKNOWN_HISTORICAL';

comment on column public.signal_history.market_session_status is
  'Immutable execution-session classification at scanned_at. Only LIVE_REGULAR_SESSION is eligible for actionable forward evaluation.';

alter table public.signal_history
  add constraint signal_history_market_session_status_check
  check (market_session_status in (
    'LIVE_REGULAR_SESSION',
    'PREMARKET_RESEARCH',
    'AFTER_HOURS_RESEARCH',
    'LATE_SESSION_RESEARCH',
    'WEEKEND_RESEARCH',
    'HOLIDAY_RESEARCH',
    'UNKNOWN_HISTORICAL'
  )) not valid;

alter table public.signal_history
  validate constraint signal_history_market_session_status_check;

create index if not exists idx_signal_history_live_forward_session
  on public.signal_history (experiment_cohort, scanned_at desc)
  where qualification_source = 'LIVE_AT_SIGNAL'
    and market_session_status = 'LIVE_REGULAR_SESSION'
    and is_lifecycle_primary = true;

alter table public.alert_prefs
  add column if not exists account_equity numeric,
  add column if not exists planned_account_risk_pct numeric not null default 0.0025,
  add column if not exists max_premium_outlay_pct numeric not null default 0.10,
  add column if not exists max_position_contracts integer not null default 10;

alter table public.alert_prefs
  add constraint alert_prefs_account_equity_check
    check (account_equity is null or (account_equity > 0 and account_equity <= 100000000)) not valid,
  add constraint alert_prefs_planned_account_risk_pct_check
    check (planned_account_risk_pct > 0 and planned_account_risk_pct <= 0.02) not valid,
  add constraint alert_prefs_max_premium_outlay_pct_check
    check (max_premium_outlay_pct > 0 and max_premium_outlay_pct <= 0.10) not valid,
  add constraint alert_prefs_max_position_contracts_check
    check (max_position_contracts between 1 and 1000) not valid;

alter table public.alert_prefs
  validate constraint alert_prefs_account_equity_check;
alter table public.alert_prefs
  validate constraint alert_prefs_planned_account_risk_pct_check;
alter table public.alert_prefs
  validate constraint alert_prefs_max_premium_outlay_pct_check;
alter table public.alert_prefs
  validate constraint alert_prefs_max_position_contracts_check;

comment on column public.alert_prefs.account_equity is
  'Optional user-provided account equity used only for educational position-sizing output.';
