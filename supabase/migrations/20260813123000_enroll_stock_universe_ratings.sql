insert into public.stock_rating_history (
  rating_date,ticker,algorithm_version,rating,technical_state,fundamental_state,
  setup,market_regime,entry_price,benchmark_price,edge_score,technical_score,
  fundamental_score,entry_low,entry_high,stop_price,target_price,inputs,updated_at
)
select
  s.snapshot_date,s.ticker,s.algorithm_version,s.rating,s.technical_state,
  s.fundamental_state,s.setup,'NIGHTLY CLOSE',s.price,spy.price,s.edge_score,
  s.technical_score,s.fundamental_score,s.entry_low,s.entry_high,s.stop_price,
  s.target_price,jsonb_build_object('source','stock_universe_snapshots','fundamentalCoverage',s.fundamental_coverage),now()
from public.stock_universe_snapshots s
left join public.stock_universe_snapshots spy
  on spy.snapshot_date=s.snapshot_date and spy.ticker='SPY' and spy.algorithm_version=s.algorithm_version
where s.eligible=true and s.rating in ('BUY_SETUP','HOLD_WAIT')
on conflict (rating_date,ticker,algorithm_version) do nothing;

with later as (
  select h.id,s.snapshot_date,s.price,
    row_number() over(partition by h.id order by s.snapshot_date) as session_number
  from public.stock_rating_history h
  join public.stock_universe_snapshots s
    on s.ticker=h.ticker and s.snapshot_date>h.rating_date and s.algorithm_version=h.algorithm_version
  where h.algorithm_version='stock-universe-v1'
), rollup as (
  select id,count(*) as sessions,max(snapshot_date) as last_date,
    (array_agg(price order by snapshot_date desc))[1] as latest_price,
    max(price) filter(where session_number=5) as price_5d,
    max(snapshot_date) filter(where session_number=5) as date_5d
  from later group by id
), benchmark as (
  select r.id,spy.price as spy_5d
  from rollup r
  left join public.stock_universe_snapshots spy
    on spy.ticker='SPY' and spy.snapshot_date=r.date_5d and spy.algorithm_version='stock-universe-v1'
)
update public.stock_rating_history h set
  sessions_observed=least(60,r.sessions),last_observed_date=r.last_date,
  latest_price=r.latest_price,
  return_5d=case when r.price_5d is not null then round(((r.price_5d/h.entry_price)-1)*100,4) else h.return_5d end,
  spy_return_5d=case when b.spy_5d is not null and h.benchmark_price is not null then round(((b.spy_5d/h.benchmark_price)-1)*100,4) else h.spy_return_5d end,
  updated_at=now()
from rollup r left join benchmark b on b.id=r.id
where h.id=r.id and h.algorithm_version='stock-universe-v1';
