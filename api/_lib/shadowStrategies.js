const SHADOW_STRATEGY_VERSION = 'profitability_shadow_v2'

function buildShadowStrategies(signal) {
  const optionType = String(signal.option_type || '').toLowerCase()
  const trend = String(signal.long_term_trend || '').toLowerCase()
  const chgPct = Number(signal.chg_pct)
  const spread = Number(signal.entry_spread_pct)
  const volume = Number(signal.volume)
  const openInterest = Number(signal.open_interest)
  const spxChange = Number(signal.regime_spx_chg_pct)
  const ndxChange = Number(signal.regime_ndx_chg_pct)
  const vixChange = Number(signal.vix_chg_pct)
  const dmiVolume = signal.dmi_volume_confirmation || null
  const expectedMovePct = Number(signal.expected_move_pct)
  const breakevenRequiredPct = Number(signal.breakeven_required_pct)
  const breakevenToExpectedMove = expectedMovePct > 0 && Number.isFinite(breakevenRequiredPct)
    ? breakevenRequiredPct / expectedMovePct
    : null
  const volatilityValueMeasured = Number.isFinite(breakevenToExpectedMove)
  const volatilityValueFavorable = volatilityValueMeasured && breakevenToExpectedMove <= 0.70
  const swingTimeframe = String(signal.timeframe || '').startsWith('Swing')
  const dmiVolumeAligned = swingTimeframe && dmiVolume?.status === 'MEASURED' && (
    (optionType === 'call' && dmiVolume.bullish_confirmed) ||
    (optionType === 'put' && dmiVolume.bearish_confirmed)
  )
  const trendAligned = (optionType === 'call' && trend === 'bullish') ||
    (optionType === 'put' && trend === 'bearish')
  const directionConfirmed = Number.isFinite(chgPct) &&
    ((optionType === 'call' && chgPct >= 0.5) || (optionType === 'put' && chgPct <= -0.5))
  const liquid = Number.isFinite(spread) && spread <= 20 &&
    Number.isFinite(volume) && volume >= 50 &&
    Number.isFinite(openInterest) && openInterest >= 500
  const confirmedBearishMarket = Number.isFinite(spxChange) && spxChange <= -0.5 &&
    Number.isFinite(ndxChange) && ndxChange <= -0.5 &&
    Number.isFinite(vixChange) && vixChange >= 3

  return {
    version: SHADOW_STRATEGY_VERSION,
    assignments: {
      regime_aligned_v2a: trendAligned,
      entry_confirmation_v2b: directionConfirmed,
      liquidity_gate_v2c: liquid,
      combined_quality_v2d: trendAligned && directionConfirmed && liquid,
      // Positive but immature forward candidate identified 2026-08-13.
      // Keep separate from combined_quality: adding trend alignment diluted
      // the observed edge. This remains shadow-only until promotion gates.
      swing_call_liquidity_entry_v3: swingTimeframe && optionType === 'call' && liquid && directionConfirmed,
      // Puts must be judged separately in a real risk-off tape. This uses
      // already-captured scan-time context (no extra provider calls) and is
      // intentionally shadow-only until bearish-market observations exist.
      bearish_regime_put_v1: optionType === 'put' && confirmedBearishMarket && directionConfirmed && liquid,
      defined_risk_spread_v2e: !!signal.shadow_vertical_spread,
      dmi_volume_confirmation_v1: dmiVolumeAligned,
      // Pure shadow hypothesis: the option needs no more than 70% of its
      // IV-implied expected underlying move to reach breakeven. This never
      // changes scoring, Quality Shortlist, or subscriber recommendations.
      volatility_value_v1: volatilityValueFavorable,
    },
    strategy_candidates: signal.strategy_candidates || null,
    exit_policies: {
      time_stop_v2f: {
        max_holding_trading_days: signal.timeframe?.startsWith('Quick') ? 3 : 10,
      },
      partial_profit_v2g: {
        partial_exit_profit_pct: 0.30,
        partial_size_pct: 0.50,
        trailing_stop_pct_on_remainder: 0.20,
      },
      tighter_stop_v2h: {
        profit_target_pct: Number.isFinite(Number(signal.profit_target_pct))
          ? Number(signal.profit_target_pct)
          : null,
        stop_loss_pct: 0.35,
      },
    },
    inputs: {
      option_type: optionType || null,
      long_term_trend: trend || null,
      chg_pct: Number.isFinite(chgPct) ? chgPct : null,
      entry_spread_pct: Number.isFinite(spread) ? spread : null,
      volume: Number.isFinite(volume) ? volume : null,
      open_interest: Number.isFinite(openInterest) ? openInterest : null,
      timeframe: signal.timeframe || null,
      regime_spx_chg_pct: Number.isFinite(spxChange) ? spxChange : null,
      regime_ndx_chg_pct: Number.isFinite(ndxChange) ? ndxChange : null,
      vix_chg_pct: Number.isFinite(vixChange) ? vixChange : null,
      dmi_volume_confirmation: swingTimeframe
        ? (dmiVolume || { status: 'UNAVAILABLE' })
        : { status: 'NOT_APPLICABLE', reason: 'Quick requires completed 15-minute candles; daily data is not substituted.' },
      volatility_value: {
        status: volatilityValueMeasured ? 'MEASURED' : 'UNAVAILABLE',
        expected_move_pct: Number.isFinite(expectedMovePct) ? expectedMovePct : null,
        breakeven_required_pct: Number.isFinite(breakevenRequiredPct) ? breakevenRequiredPct : null,
        breakeven_to_expected_move_ratio: breakevenToExpectedMove,
        favorable_threshold: 0.70,
        methodology: 'contract_iv_sqrt_time',
        shadow_only: true,
      },
    },
    shadow_only: true,
  }
}

module.exports = { buildShadowStrategies, SHADOW_STRATEGY_VERSION }
