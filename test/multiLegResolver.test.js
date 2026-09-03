const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveCandidateAtExit, selectMarkAtOrBefore, buildResolutionRecord } = require('../api/_lib/multiLegResolver')
const { determineExitPoint } = require('../api/admin/multileg-outcome-resolver')._test

test('resolves long, debit, and credit cashflows after identical per-leg costs', () => {
  const long = resolveCandidateAtExit({ id: 'LONG_CALL', family: 'LONG_OPTION', entryDebit: 5, maxLoss: 5, legs: [{ quantity: 1 }] }, [7])
  const debit = resolveCandidateAtExit({ id: 'BULL_CALL_DEBIT', family: 'DEFINED_RISK_DEBIT', entryDebit: 3, maxLoss: 3, legs: [{ quantity: 1 }, { quantity: -1 }] }, [7, 2])
  const credit = resolveCandidateAtExit({ id: 'BULL_PUT_CREDIT', family: 'DEFINED_RISK_CREDIT', entryCredit: 1, maxLoss: 4, legs: [{ quantity: -1 }, { quantity: 1 }] }, [0.3, 0.05])
  assert.ok(long.returnOnRisk > 0)
  assert.ok(debit.returnOnRisk > 0)
  assert.ok(credit.returnOnRisk > 0)
  assert.ok([long, debit, credit].every(result => result.estimatedFeesPerShare > 0))
})

test('selects the latest real mark at or before the shared exit time', () => {
  const bars = [
    { time: '2026-08-17T14:59:00Z', close: 2 },
    { time: '2026-08-17T15:00:00Z', close: 2.1 },
    { time: '2026-08-17T15:01:00Z', close: 9 },
  ]
  assert.equal(selectMarkAtOrBefore(bars, '2026-08-17T15:00:30Z').close, 2.1)
})

test('incomplete evidence can never become publish-eligible', () => {
  const unavailable = buildResolutionRecord({ exitAt: '2026-08-17T15:00:00Z', dataStatus: 'UNAVAILABLE', reason: 'NO_SYNCHRONIZED_MARK' })
  assert.equal(unavailable.publishEligibleEvidence, false)
  assert.deepEqual(unavailable.candidates, [])
})

test('uses the actual threshold-hit wall clock instead of the later resolver run time', () => {
  const exit = determineExitPoint({
    resolved_at: '2026-08-29T03:57:02.521Z',
    hit_stop_at: '2026-08-28T12:18:00.000Z',
    resolution_method: 'stop_hit',
    expiry_raw: '2026-09-18',
  })
  assert.deepEqual(exit, {
    ok: true,
    date: '2026-08-28',
    time: '12:18',
    compareAt: '2026-08-28T12:18:00.000Z',
    source: 'UNDERLYING_THRESHOLD_HIT',
  })
})

test('rejects day-level fallback exits that cannot provide synchronized marks', () => {
  assert.deepEqual(determineExitPoint({
    hit_target_at: '2026-08-20T00:00:00.000Z',
    resolution_method: 'daily_bar_fallback_target',
  }), { ok: false, reason: 'UNDERLYING_EXIT_TIME_NOT_INTRADAY' })
})

test('prices expired positions at the expiry session close', () => {
  const exit = determineExitPoint({ expiry_raw: '2026-09-18', resolution_method: 'expired_flat' })
  assert.equal(exit.ok, true)
  assert.equal(exit.date, '2026-09-18')
  assert.equal(exit.time, '16:00')
})
