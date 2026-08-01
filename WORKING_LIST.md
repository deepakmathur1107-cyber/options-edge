# Options Edge Working List

## Research / shadow strategies

### Direction stability using DMI/ADX and TTM Squeeze

- Status: Planned for shadow evaluation; do not affect production recommendations.
- Objective: Reduce noisy same-ticker direction reversals, such as a Quick put followed shortly by a Quick call.
- Proposed version: `direction_stability_v1`.
- Quick timeframe inputs: Completed 15-minute candles.
- Swing timeframe inputs: Completed daily candles.
- Candidate call confirmation: `+DI > -DI`, DI separation at least 5, ADX at least 20 and rising, positive/strengthening TTM momentum or a recent bullish squeeze release, confirmed on two completed candles.
- Candidate put confirmation: `-DI > +DI`, DI separation at least 5, ADX at least 20 and rising, negative/weakening TTM momentum or a recent bearish squeeze release, confirmed on two completed candles.
- Conflict behavior: Classify as `MIXED_WAIT`; do not shortlist either direction.
- Reversal behavior: Do not replace an active direction until the opposing direction passes two completed-bar confirmations and the ticker-level reversal gate.
- Required stored evidence: DMI period, `plus_di`, `minus_di`, ADX value and slope, squeeze state, squeeze-release age, momentum value and slope, candle interval, candle close time, decision, and exclusion reasons.
- Initial evaluation: Shadow-only using lifecycle-primary, `LIVE_AT_SIGNAL` observations.
- Minimum review sample: 300 resolved, non-overlapping observations across at least 30 trading sessions, with ticker and sector concentration limits satisfied.
- Promotion criteria: Positive execution-adjusted expectancy; profit factor at least 1.20; maximum drawdown no worse than the production baseline; improved contradictory-direction rate; stable results across at least three time cohorts; and no material degradation in signal availability.
- Promotion process: Human review and explicit versioned production release. Never promote automatically.

#### Implementation update

- `dmi_volume_confirmation_v1` is implemented as a Swing-only shadow assignment using the scanner's existing cached daily OHLCV request, so it adds no Tradier calls.
- Stored evidence includes DI+, DI-, ADX and slope, volume-weighted 3/12 momentum and its 9-period signal average, VZO, bar interval, and bar date.
- Quick remains explicitly not applicable until completed 15-minute candles can be collected without exhausting the market-data budget.
- TTM Squeeze remains a separate planned shadow component and has not been silently substituted or inferred.
