-- Keep an internal, service-role-only record of the one-time merge so every
-- repaired lifecycle remains auditable and recoverable.
create table if not exists public.signal_lifecycle_merge_audit (
  duplicate_lifecycle_id uuid primary key,
  canonical_lifecycle_id uuid not null,
  merged_at timestamptz not null default now()
);

alter table public.signal_lifecycle_merge_audit enable row level security;
revoke all on table public.signal_lifecycle_merge_audit from anon, authenticated;
grant all on table public.signal_lifecycle_merge_audit to service_role;

-- Collapse concurrently-created pending primary lifecycles onto the earliest
-- primary for the same economic contract. Secondary observations are retained.
with ranked_primaries as (
  select
    id,
    signal_lifecycle_id,
    first_value(signal_lifecycle_id) over (
      partition by ticker, option_type, primary_strike, expiry_raw
      order by scanned_at, id
    ) as canonical_lifecycle_id,
    row_number() over (
      partition by ticker, option_type, primary_strike, expiry_raw
      order by scanned_at, id
    ) as lifecycle_rank
  from public.signal_history
  where is_lifecycle_primary = true
    and outcome is null
    and resolved_at is null
), duplicate_lifecycles as (
  select signal_lifecycle_id, canonical_lifecycle_id
  from ranked_primaries
  where lifecycle_rank > 1
), audit as (
  insert into public.signal_lifecycle_merge_audit (
    duplicate_lifecycle_id,
    canonical_lifecycle_id
  )
  select signal_lifecycle_id, canonical_lifecycle_id
  from duplicate_lifecycles
  on conflict (duplicate_lifecycle_id) do nothing
  returning duplicate_lifecycle_id
), remap as (
  update public.signal_history history
  set
    signal_lifecycle_id = duplicates.canonical_lifecycle_id,
    is_lifecycle_primary = false
  from duplicate_lifecycles duplicates
  where history.signal_lifecycle_id = duplicates.signal_lifecycle_id
  returning history.id
)
select count(*) from remap;

-- The application still performs a friendly lifecycle lookup, but this index
-- is the authoritative race-condition guard when two scan invocations overlap.
create unique index if not exists uq_signal_history_one_open_primary_contract
  on public.signal_history (
    ticker,
    option_type,
    primary_strike,
    expiry_raw
  ) nulls not distinct
  where is_lifecycle_primary = true
    and outcome is null
    and resolved_at is null;

-- Preserve an hourly heartbeat for research, but do not store an identical
-- observation every 15 minutes. A lifecycle-scoped advisory lock also prevents
-- overlapping scans from both writing the same unchanged secondary snapshot.
create or replace function public.suppress_unchanged_signal_observation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  previous public.signal_history%rowtype;
begin
  if new.is_lifecycle_primary is true or new.signal_lifecycle_id is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.signal_lifecycle_id::text, 0));

  select *
  into previous
  from public.signal_history
  where signal_lifecycle_id = new.signal_lifecycle_id
  order by scanned_at desc, id desc
  limit 1;

  if found
    and previous.scanned_at > new.scanned_at - interval '60 minutes'
    and previous.score is not distinct from new.score
    and previous.grade is not distinct from new.grade
    and previous.entry_mid is not distinct from new.entry_mid
    and previous.bid is not distinct from new.bid
    and previous.ask is not distinct from new.ask
    and previous.underlying_price is not distinct from new.underlying_price
    and previous.direction_decision is not distinct from new.direction_decision
    and previous.warnings is not distinct from new.warnings
    and previous.hard_blocks is not distinct from new.hard_blocks
    and previous.strategy_qualified is not distinct from new.strategy_qualified
  then
    return null;
  end if;

  return new;
end;
$$;

revoke all on function public.suppress_unchanged_signal_observation() from public, anon, authenticated;
grant execute on function public.suppress_unchanged_signal_observation() to service_role;

drop trigger if exists trg_suppress_unchanged_signal_observation on public.signal_history;
create trigger trg_suppress_unchanged_signal_observation
before insert on public.signal_history
for each row
execute function public.suppress_unchanged_signal_observation();
