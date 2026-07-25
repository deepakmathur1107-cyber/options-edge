// api/_lib/strategyClassification.js
// Added 2026-07-25. "Qualified Strategy V1" per the shared strategy
// document (2026-07-21) — architected against our actual schema rather
// than applied blindly. Key adaptations from the original proposal:
//   - Reuses entry_spread_pct (already built) instead of a duplicate
//     derived_spread_pct column.
//   - Reuses profitTargetPct/stopLossPct (already computed per-timeframe
//     in scanLogic.js) instead of recomputing planned_risk_pct/reward.
//   - SHADOW ONLY, same discipline as every other classification this
//     session: this labels signals, it does not filter, block, or change
//     what's scored or displayed. The document's own promotion gates
//     (300 resolved, 2 non-overlapping monthly cohorts, etc.) still apply
//     before any of this could inform a live product decision.
//
// Classification is deliberately SIMPLE — call, Swing timeframe, DTE
// 21-45, nothing else. The document explicitly found no stable
// improvement from adding score/delta/IV/volume/OI filters on top of
// this, and a fresh check against our own live data (2026-07-21) didn't
// contradict that either (Swing call score buckets aren't cleanly
// monotonic). Resist the urge to add filters without re-testing first —
// that's exactly the kind of undisciplined iteration this session's
// pause was about.

const STRATEGY_VERSION = 'swing_call_v1'

// classifyStrategy(signal) — signal needs option_type, timeframe,
// dte_at_signal. Returns one of: QUALIFIED_V1, PUT_RESEARCH,
// QUICK_CALL_RESEARCH, OTHER_RESEARCH. Never throws — a classification
// failure must never block a signal from being recorded; OTHER_RESEARCH
// is always a safe fallback.
function classifyStrategy(signal) {
  try {
    const optionType = (signal.option_type || '').toLowerCase()
    const dte = Number(signal.dte_at_signal)

    if (
      optionType === 'call' &&
      signal.timeframe === 'Swing (21–45 DTE)' &&
      dte >= 21 && dte <= 45
    ) {
      return 'QUALIFIED_V1'
    }
    if (optionType === 'put') return 'PUT_RESEARCH'
    if (optionType === 'call' && signal.timeframe === 'Quick (5–14 DTE)') return 'QUICK_CALL_RESEARCH'
    return 'OTHER_RESEARCH'
  } catch (e) {
    console.error('[strategyClassification] classification failed, defaulting to OTHER_RESEARCH:', e.message)
    return 'OTHER_RESEARCH'
  }
}

// buildQualificationRecord(signal) — the full set of fields to write to
// signal_history for this signal. Pure, synchronous, no I/O — safe to call
// for every signal regardless of outcome.
function buildQualificationRecord(signal, metadata = {}) {
  const classification = classifyStrategy(signal)
  const qualified = classification === 'QUALIFIED_V1'
  const assignedAt = metadata.assigned_at || new Date().toISOString()
  const qualificationSource = metadata.qualification_source || 'LIVE_AT_SIGNAL'
  const cohort = metadata.experiment_cohort ||
    (assignedAt ? `forward_${assignedAt.slice(0, 7)}` : null)

  const reasons = []
  if (qualified) {
    reasons.push('CALL_OPTION', 'SWING_TIMEFRAME', 'DTE_21_TO_45')
  } else {
    if ((signal.option_type || '').toLowerCase() === 'put') reasons.push('PUT_EXCLUDED')
    if (signal.timeframe !== 'Swing (21–45 DTE)') reasons.push('NOT_SWING_TIMEFRAME')
    const dte = Number(signal.dte_at_signal)
    if (signal.timeframe === 'Swing (21–45 DTE)' && (dte < 21 || dte > 45)) reasons.push('DTE_OUT_OF_RANGE')
  }

  return {
    strategy_version: STRATEGY_VERSION,
    strategy_classification: classification,
    strategy_qualified: qualified,
    qualification_reasons: reasons,
    // Snapshot prevents future code changes from silently altering the
    // historical explanation of why a signal qualified — per the
    // document's own stated rationale, worth preserving as-is.
    qualification_snapshot: {
      option_type: signal.option_type,
      timeframe: signal.timeframe,
      dte_at_signal: signal.dte_at_signal,
      entry_mid: signal.entry_mid,
      bid: signal.bid,
      ask: signal.ask,
      delta: signal.delta,
      iv: signal.iv,
      profit_target_pct: signal.profit_target_pct,
      stop_loss_pct: signal.stop_loss_pct,
      score: signal.score,
    },
    shadow_mode: true,
    // Premium-stop movement and account allocation are deliberately separate:
    // a 50% option stop does not mean 50% of account equity is at risk.
    premium_stop_loss_pct: signal.stop_loss_pct ?? null,
    planned_account_risk_pct: metadata.planned_account_risk_pct ?? null,
    planned_risk_reward: (signal.profit_target_pct != null && signal.stop_loss_pct)
      ? Math.round((signal.profit_target_pct / signal.stop_loss_pct) * 100) / 100
      : null,
    strategy_assigned_at: assignedAt,
    qualification_source: qualificationSource,
    experiment_cohort: qualified ? cohort : null,
    experiment_enrolled_at: qualified ? assignedAt : null,
  }
}

module.exports = { classifyStrategy, buildQualificationRecord, STRATEGY_VERSION }
