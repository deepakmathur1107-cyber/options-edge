-- Stage 2 of 4 (backfill).
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
