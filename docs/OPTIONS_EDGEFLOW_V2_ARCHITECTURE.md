# OptionsEdgeFlow V2 architecture and implementation plan

## Safety and rollout posture

V2 is additive and shadow-first. Existing scans, journaling, alerts, subscriptions, and outcome resolution remain intact. A candidate may be visible as research, but the publish decision is `NO_TRADE` unless the exact strategy has positive out-of-sample expectancy after costs and passes every validation gate. Win rate alone is never sufficient.

No naked short options, short strangles, Wheel, calendars, ratio spreads, or Iron Condors are in scope. Iron Condors remain blocked until a separate neutral/range signal is validated.

## Current architecture

- React/Vite client in `src/`.
- Vercel serverless APIs and scheduled jobs in `api/`.
- Tradier supplies quotes, chains, Greeks, and historical bars through `api/_lib/tradierClient.js`.
- Clerk handles identity; Stripe handles subscriptions.
- Supabase stores the current scan cache, permanent signal history, outcomes, experiments, user journals, and forward measurements.
- `scan_results` is short-lived and UI-facing. `signal_history` is append-only evidence and is the source for research validation.
- Existing profitability support includes execution-adjusted long-option outcomes, promotion gates, shadow classifications, and debit-vertical snapshots.

## Audit findings

- Production contains about 460,000 signal-history rows, but only lifecycle-primary rows are statistically eligible; repeated scanner refreshes must not be treated as independent trades.
- Execution-adjusted measurements exist for long options.
- Greeks and expected-move columns exist and scan code populates them for new records, but the audited production snapshot had no populated full-Greeks or expected-move rows. This is a data-coverage issue, not a missing-column issue.
- The prior debit-spread comparison used settlement-only spread exits against target/stop long-option exits. It is not apples-to-apples and cannot justify publication.
- There is no validated credit-spread dataset.
- Existing qualified signals have not demonstrated positive net out-of-sample expectancy. The default production-safe decision is therefore `NO_TRADE`.

## V2 model boundary

The model is split into three independent layers:

1. **Market and contract facts:** underlying price, IV, delta/gamma/theta/vega, expected move, DTE, bid/ask, volume, open interest, earnings distance, and quote timestamp.
2. **Strategy candidate:** legs, side, quantity, entry debit/credit, maximum profit/loss, breakeven, execution assumptions, liquidity state, and model version.
3. **Validation evidence:** immutable in-sample/out-of-sample partition, cohort, net return on risk, costs, holding period, drawdown path, concentration, and promotion decision.

An OE Profitability Score summarizes evidence quality, expectancy, drawdown, liquidity, and quote quality for ranking. It cannot override the hard gate.

## Strategy comparison

For each lifecycle-primary directional signal, the comparison uses the same ticker, direction, entry timestamp, and exit timestamp:

- A: existing long call or put.
- B: bull-call or bear-put debit vertical.
- C: defined-risk bull-put or bear-call credit vertical.

Each structure is evaluated on return on maximum risk after per-leg entry/exit slippage and contract fees. The report includes sample size, win rate, expectancy, profit factor, average win/loss, maximum drawdown, return on risk, Sharpe, and holding period.

The initial model uses Black-Scholes repricing with the signal-time IV held constant when actual synchronized historical quotes for every leg are unavailable. Such results must be labeled `MODELED_CONSTANT_IV`, kept separate from actual-fill evidence, and cannot alone authorize publication. Actual bid/ask snapshots and synchronized leg marks are the promotion-grade target.

## Publish / No Trade gate

Publication requires all of the following:

- Explicit out-of-sample partition.
- At least 300 resolved trades across at least two cohorts.
- Positive expectancy after costs.
- Profit factor at least 1.20.
- Sharpe above zero.
- Maximum drawdown no greater than 25% of the modeled equity curve.
- Same signal and timing used for competing structures.
- Cost model applied.

Missing data or a failed check produces `NO_TRADE`. Research rows remain visible so data collection and diagnosis continue.

## Cost-conscious data plan

- Reuse the chain already fetched during a scan; do not add tick-level WebSockets.
- Begin with the current universe and scheduled scans.
- Persist quote timestamps and all candidate legs at signal time.
- Collect forward daily or scan-time snapshots before buying historical options data.
- Expand symbols or cadence only after evidence shows the current pipeline is the limiting factor.

## Implementation phases

1. Foundation: option model, metrics, OE Profitability Score, hard gate, data-coverage telemetry.
2. Candidate generation: construct A/B/C from one live chain and persist immutable inputs in shadow mode.
3. Backtest: enforce identical signal/entry/exit timing, calculate all required metrics, and separate modeled from actual evidence.
4. Forward validation: freeze rules, collect non-overlapping cohorts, and monitor concentration/data quality.
5. Product promotion: human review, then enable only the exact strategy/version that passes. All others remain `NO_TRADE`.

## Assumptions and known limitations

- American early-exercise effects are not modeled in the initial Black-Scholes comparison; this is conservative documentation debt for dividend-sensitive names and short ITM legs.
- Constant-IV repricing isolates structure geometry but does not model skew or IV changes.
- Historical signal rows without synchronized leg quotes are insufficient for actual-fill claims.
- Database schema additions should be generated with the Supabase CLI and reviewed before production application. The local CLI is currently unavailable, so this change set intentionally reuses existing JSON/measurement fields and does not fabricate a migration filename.
