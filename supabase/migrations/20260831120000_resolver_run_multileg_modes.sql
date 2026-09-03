alter table public.resolver_runs
  drop constraint if exists resolver_runs_mode_check;

alter table public.resolver_runs
  add constraint resolver_runs_mode_check
  check (mode in ('nightly', 'burndown', 'manual', 'qualified', 'multileg'));
