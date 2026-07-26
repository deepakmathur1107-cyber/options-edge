create table if not exists public.resolver_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  mode text not null check (mode in ('nightly', 'burndown', 'manual')),
  batch_limit integer not null check (batch_limit > 0),
  rows_fetched integer not null default 0 check (rows_fetched >= 0),
  rows_processed integer not null default 0 check (rows_processed >= 0),
  resolved integer not null default 0 check (resolved >= 0),
  still_open integer not null default 0 check (still_open >= 0),
  data_unavailable integer not null default 0 check (data_unavailable >= 0),
  errors integer not null default 0 check (errors >= 0),
  circuit_broken boolean not null default false,
  timed_out boolean not null default false,
  tradier_calls integer not null default 0 check (tradier_calls >= 0),
  status_counts jsonb not null default '{}'::jsonb,
  min_available integer,
  deployment_sha text
);

alter table public.resolver_runs enable row level security;
revoke all on table public.resolver_runs from anon, authenticated;
grant all on table public.resolver_runs to service_role;
grant usage, select on sequence public.resolver_runs_id_seq to service_role;

create index if not exists idx_resolver_runs_started_at
  on public.resolver_runs (started_at desc);

comment on table public.resolver_runs is
  'Internal resolver execution telemetry. Service-role only; no customer access.';
