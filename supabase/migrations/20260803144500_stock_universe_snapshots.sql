create table if not exists public.stock_universe_snapshots (
  snapshot_date date not null,
  ticker text not null check (ticker ~ '^[A-Z][A-Z.-]{0,5}$'),
  algorithm_version text not null,
  company_name text,
  sector text,
  industry text,
  price numeric not null check (price > 0),
  average_volume bigint check (average_volume >= 0),
  market_cap numeric check (market_cap >= 0),
  pe_ratio numeric,
  earnings_date date,
  fundamental_state text not null,
  fundamental_score smallint check (fundamental_score between 0 and 100),
  fundamental_coverage smallint not null check (fundamental_coverage between 0 and 100),
  technical_state text not null,
  technical_score smallint check (technical_score between 0 and 100),
  edge_score smallint check (edge_score between 0 and 100),
  rating text not null check (rating in ('BUY_SETUP','HOLD_WAIT','EXCLUDED')),
  setup text,
  rsi smallint check (rsi between 0 and 100),
  volume_ratio numeric,
  sma_20 numeric,
  sma_50 numeric,
  support numeric,
  resistance numeric,
  entry_low numeric,
  entry_high numeric,
  stop_price numeric,
  target_price numeric,
  eligible boolean not null default false,
  exclusion_reason text,
  analysis_reason text,
  captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (snapshot_date, ticker, algorithm_version)
);

create table if not exists public.stock_universe_runs (
  run_date date primary key,
  algorithm_version text not null,
  cursor_position integer not null default 0 check (cursor_position >= 0),
  universe_size integer not null check (universe_size >= 0),
  processed_count integer not null default 0 check (processed_count >= 0),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  status text not null check (status in ('RUNNING','COMPLETE','FAILED')),
  last_errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.stock_universe_snapshots enable row level security;
alter table public.stock_universe_runs enable row level security;

revoke all on table public.stock_universe_snapshots from anon, authenticated;
revoke all on table public.stock_universe_runs from anon, authenticated;
revoke all on table public.stock_universe_snapshots from service_role;
revoke all on table public.stock_universe_runs from service_role;
grant select, insert, update on table public.stock_universe_snapshots to service_role;
grant select, insert, update on table public.stock_universe_runs to service_role;

create index if not exists idx_stock_universe_eligible_ranking
  on public.stock_universe_snapshots (snapshot_date desc, rating, edge_score desc, ticker)
  where eligible = true;

create index if not exists idx_stock_universe_ticker_history
  on public.stock_universe_snapshots (ticker, snapshot_date desc);

comment on table public.stock_universe_snapshots is
  'Server-only nightly stock research cache. Penny stocks, illiquid names, and weak/incomplete fundamentals are excluded before presentation.';
comment on table public.stock_universe_runs is
  'Checkpoint table for bounded nightly stock-universe batches; independent from options signal resolvers.';
