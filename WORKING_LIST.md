# Options Edge Working List

## Research / shadow strategies

All items in this section are measurement-only. They must not alter conviction scores, Quality Shortlist eligibility, subscriber labels, alerts, or trade recommendations before promotion criteria pass and a human explicitly approves a versioned production release.

### Recent direction stability

- Experiment: `direction_stability_v1`.
- Status: Forward shadow measurement; not a live gate.
- Hypothesis: Signals that retain the same ticker/timeframe direction will have higher execution-adjusted expectancy than signals that switch between calls and puts within 90 minutes.
- Current threshold: 90 minutes, registered as an unvalidated starting hypothesis rather than a production rule.
- Stored evidence: Status, current and previous side, minutes between directions, lifecycle IDs, and whether both sides eventually resolve as losses.
- Comparison: Admin reports selected-versus-rejected expectancy, profit factor, win rate, sample size, and cohort days.
- Live behavior: None. No shortlist exclusion and no subscriber-facing warning.

### DMI and volume confirmation

- Experiment: `dmi_volume_confirmation_v1`.
- Status: Forward shadow measurement; not a live gate.
- Objective: Test whether Wilder DMI/ADX, volume-weighted 3/12 momentum with a 9-period signal average, and VZO improve Swing entry selection.
- Swing inputs: Existing cached daily OHLCV history; no additional Tradier requests.
- Quick inputs: Not applicable until completed 15-minute candles can be collected within the market-data budget. Daily data is not substituted.
- Stored evidence: DI+, DI-, ADX and slope, volume-weighted momentum and signal average, VZO, bar interval, bar date, direction decision, and assignment.

### TTM Squeeze

- Status: Planned separately; not implemented and not inferred from DMI/volume evidence.
- Required evidence: Squeeze state, release age, momentum value and slope, completed candle interval, and direction agreement.

## Promotion requirements

- At least 300 resolved, lifecycle-primary `LIVE_AT_SIGNAL` observations.
- At least 30 trading sessions and three stable, non-overlapping time cohorts.
- Positive execution-adjusted expectancy and profit factor of at least 1.20.
- Maximum drawdown no worse than the production baseline.
- Acceptable ticker and sector concentration.
- Positive selection lift versus the rejected comparison group.
- No material degradation in signal availability.
- Experiment-ledger review and explicit human approval. Never promote automatically.
