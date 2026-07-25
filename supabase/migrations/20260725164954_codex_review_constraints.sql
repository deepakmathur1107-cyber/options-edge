-- Stage 3 of 4 (constraints). NOT VALID first (fast, doesn't scan/lock),
-- then VALIDATE separately (takes a lighter SHARE UPDATE EXCLUSIVE lock,
-- not a full table rewrite) — correct pattern for a 330K-row table.
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
      'QUALIFIED_V1', 'PUT_RESEARCH', 'QUICK_CALL_RESEARCH', 'OTHER_RESEARCH'
    )
  ) not valid;

alter table public.signal_history
  validate constraint signal_history_qualification_source_check;
alter table public.signal_history
  validate constraint signal_history_strategy_classification_check;
