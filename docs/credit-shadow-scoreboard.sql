-- swing_credit_spread_managed_v1 scoreboard (shadow only).
-- Primary metric: pooled net return on risk per closed position, natural fills.
-- Win rate is shown for context only; it is not a decision gate.

-- 1. Results by arm
select arm,
  count(*) filter (where status = 'CLOSED') closed,
  count(*) filter (where status = 'OPEN') open,
  count(*) filter (where status = 'DATA_UNAVAILABLE') data_unavailable,
  round(sum(net_pnl_dollars) filter (where status = 'CLOSED')
    / nullif(sum(max_loss * 100 + 1.30) filter (where status = 'CLOSED'), 0), 4) pooled_return_on_risk,
  round(avg(return_on_risk) filter (where status = 'CLOSED'), 4) avg_return_on_risk,
  round(sum(greatest(net_pnl_dollars, 0)) filter (where status = 'CLOSED')
    / nullif(abs(sum(least(net_pnl_dollars, 0)) filter (where status = 'CLOSED')), 0), 3) profit_factor,
  round(100.0 * avg((net_pnl_dollars > 0)::int) filter (where status = 'CLOSED'), 1) win_pct,
  count(distinct date_trunc('month', entry_at)) monthly_cohorts
from shadow_credit_positions
group by arm order by arm;

-- 2. Exit reasons by arm
select arm, exit_reason, count(*), round(avg(return_on_risk), 4) avg_ror, round(avg(days_held), 1) avg_days
from shadow_credit_positions where status = 'CLOSED'
group by 1, 2 order by 1, 2;

-- 3. Why trades were rejected (daily open runs)
select started_at::date, details->'tally' tally
from resolver_runs where mode = 'credit_open'
order by started_at desc limit 10;

-- 4. Ticker concentration (gate: no ticker above 15% of an arm's positions)
select arm, ticker, count(*),
  round(count(*)::numeric / sum(count(*)) over (partition by arm), 3) share
from shadow_credit_positions group by 1, 2 order by share desc limit 15;
