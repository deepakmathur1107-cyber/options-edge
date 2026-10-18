-- swing_credit_spread_managed_v1 (registered 2026-10-18).
-- Shadow-only forward test of managed defined-risk credit spreads.
-- Nothing in this table feeds live scores, rankings, or any user-facing
-- surface. Spec: specs/shadow-spec-liquidity-credit-v1.md (project docs).

create table if not exists public.shadow_credit_positions (
  id bigint generated always as identity primary key,
  strategy_version text not null default 'swing_credit_spread_managed_v1',
  measurement_version text not null default 'credit_mgmt_v1',
  arm text not null check (arm in ('A_INDEX', 'B_STOCK', 'C_SIGNAL')),
  ticker text not null,
  side text not null check (side in ('BULL_PUT', 'BEAR_CALL')),
  expiry date not null,
  dte_at_entry integer not null check (dte_at_entry >= 0),
  short_strike numeric not null,
  long_strike numeric not null,
  width numeric not null check (width > 0),
  short_symbol text not null,
  long_symbol text not null,
  short_delta_at_entry numeric,
  short_iv_at_entry numeric,
  underlying_at_entry numeric not null,
  trend_at_entry text,
  entry_at timestamptz not null default now(),
  entry_week date not null,
  entry_credit_natural numeric not null check (entry_credit_natural > 0),
  entry_credit_mid numeric,
  credit_to_width numeric not null,
  max_loss numeric not null check (max_loss > 0),
  source_signal_id bigint,
  status text not null default 'OPEN' check (status in ('OPEN', 'CLOSED', 'DATA_UNAVAILABLE')),
  exit_at timestamptz,
  exit_reason text check (exit_reason is null or exit_reason in ('TAKE_PROFIT', 'STOP', 'TIME_21DTE', 'EXPIRY')),
  exit_debit_natural numeric,
  fees_dollars numeric,
  net_pnl_dollars numeric,
  return_on_risk numeric,
  days_held integer,
  missing_mark_days integer not null default 0,
  last_marked_date date,
  daily_marks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shadow_credit_positions_one_per_week unique (arm, ticker, entry_week),
  constraint shadow_credit_positions_strikes_ordered check (
    (side = 'BULL_PUT' and long_strike < short_strike) or
    (side = 'BEAR_CALL' and long_strike > short_strike)
  )
);

comment on table public.shadow_credit_positions is
  'Shadow-only managed credit spread positions (swing_credit_spread_managed_v1). One row per arm/ticker/ISO week. Never feeds live scoring or any user-facing surface. Service role only.';
comment on column public.shadow_credit_positions.entry_credit_natural is
  'Per-share credit at natural prices: short bid minus long ask. Primary measurement basis.';
comment on column public.shadow_credit_positions.max_loss is
  'Per-share maximum loss: width minus natural credit.';
comment on column public.shadow_credit_positions.return_on_risk is
  'net_pnl_dollars divided by (max_loss * 100 + entry fees). Fees are $0.65 per contract per side.';

create index if not exists shadow_credit_positions_open_idx
  on public.shadow_credit_positions (status, expiry)
  where status = 'OPEN';

alter table public.shadow_credit_positions enable row level security;
-- No policies: anon and authenticated roles get no access. The service role
-- bypasses RLS, matching resolver_runs.

alter table public.resolver_runs
  drop constraint if exists resolver_runs_mode_check;

alter table public.resolver_runs
  add constraint resolver_runs_mode_check
  check (mode in ('nightly', 'burndown', 'manual', 'qualified', 'multileg', 'credit_open', 'credit_manage'));

-- Per-run detail for jobs whose outcome is not an HTTP status (for example,
-- why credit spreads were rejected). status_counts stays HTTP-only because
-- resolverHealth.js reads it as HTTP status counts.
alter table public.resolver_runs
  add column if not exists details jsonb;
