const test = require('node:test')
const assert = require('node:assert/strict')
const {
  RULES, isoWeekStart, legSpreadPct, pickExpiry, pickSide, buildCreditSpread,
  settlementDebit, evaluateExit, computePnl, hasEarningsBeforeExpiry,
} = require('../api/_lib/creditSpreadShadow')

function put(strike, bid, ask, delta) {
  return { symbol: `SPY261127P${String(strike * 1000).padStart(8, '0')}`, option_type: 'put', strike, bid, ask, greeks: { delta: -delta, mid_iv: 0.18 } }
}
function call(strike, bid, ask, delta) {
  return { symbol: `SPY261127C${String(strike * 1000).padStart(8, '0')}`, option_type: 'call', strike, bid, ask, greeks: { delta, mid_iv: 0.18 } }
}

// Underlying 500. Liquid, roughly realistic 1-wide put ladder.
const liquidPuts = [
  put(480, 1.60, 1.62, 0.17),
  put(481, 1.80, 1.82, 0.19),
  put(482, 2.02, 2.04, 0.21),
  put(483, 2.26, 2.28, 0.23),
  put(484, 2.52, 2.54, 0.25),
  put(485, 2.80, 2.82, 0.27),
  put(486, 3.10, 3.12, 0.29),
  put(487, 3.42, 3.44, 0.31),
  put(488, 3.76, 3.78, 0.33),
  put(501, 9.00, 9.05, 0.52),
]

test('isoWeekStart returns the Monday of the week', () => {
  assert.equal(isoWeekStart('2026-10-18'), '2026-10-12') // Sunday
  assert.equal(isoWeekStart('2026-10-19'), '2026-10-19') // Monday
  assert.equal(isoWeekStart('2026-10-23'), '2026-10-19') // Friday
})

test('legSpreadPct requires a two-sided quote', () => {
  assert.equal(legSpreadPct({ bid: 0, ask: 1 }), null)
  assert.equal(legSpreadPct({ bid: 1.1, ask: 1 }), null)
  assert.ok(Math.abs(legSpreadPct({ bid: 0.95, ask: 1.05 }) - 10) < 1e-9)
})

test('pickExpiry chooses the expiry nearest 38 DTE inside 30-45', () => {
  const today = '2026-10-19'
  const picked = pickExpiry(['2026-11-13', '2026-11-20', '2026-11-27', '2026-12-04', '2026-12-18'], today)
  assert.deepEqual(picked, { expiry: '2026-11-27', dte: 39 })
  assert.equal(pickExpiry(['2026-10-30', '2026-12-31'], today), null)
})

test('pickSide follows each arm rule', () => {
  assert.equal(pickSide({ arm: 'A_INDEX', price: 510, sma200: 480 }), 'BULL_PUT')
  assert.equal(pickSide({ arm: 'A_INDEX', price: 470, sma200: 480 }), 'BEAR_CALL')
  assert.equal(pickSide({ arm: 'A_INDEX', price: 470, sma200: null }), null)
  assert.equal(pickSide({ arm: 'B_STOCK', trend: 'bullish' }), 'BULL_PUT')
  assert.equal(pickSide({ arm: 'B_STOCK', trend: 'mixed' }), null)
  assert.equal(pickSide({ arm: 'C_SIGNAL', signalOptionType: 'put' }), 'BEAR_CALL')
  assert.equal(pickSide({ arm: 'C_SIGNAL', signalOptionType: 'CALL' }), 'BULL_PUT')
})

test('builds a bull put with the short nearest 0.30 delta and the narrowest passing wing', () => {
  const result = buildCreditSpread({ chain: liquidPuts, price: 500, side: 'BULL_PUT', arm: 'A_INDEX' })
  assert.equal(result.ok, true)
  const s = result.spread
  assert.equal(s.short_strike, 486)        // 0.29 is nearest 0.30
  assert.equal(s.long_strike, 485)         // 1-wide: credit 3.10-2.82 = 0.28 >= 0.25
  assert.equal(s.width, 1)
  assert.equal(s.entry_credit_natural, 0.28)
  assert.equal(s.entry_credit_mid, 0.3)
  assert.equal(s.max_loss, 0.72)
  assert.ok(s.credit_to_width >= RULES.minCreditToWidth)
})

test('widens the wing when the 1-wide credit is below the minimum', () => {
  const thin = liquidPuts.map(leg => leg.strike === 485 ? put(485, 2.88, 2.90, 0.27) : leg)
  const result = buildCreditSpread({ chain: thin, price: 500, side: 'BULL_PUT', arm: 'A_INDEX' })
  assert.equal(result.ok, true)
  assert.equal(result.spread.long_strike, 484) // 3.10-2.54 = 0.56 on 2-wide
})

test('rejects when crossing the spread eats too much of the mid credit', () => {
  const costly = [
    put(94, 3.30, 3.60, 0.26),  // 8.7% leg spread
    put(95, 4.00, 4.40, 0.30),  // 9.5% leg spread
    put(100, 6.00, 6.40, 0.50),
  ]
  // mid credit 0.75, natural 0.40: crossing costs 47% of the mid credit.
  const result = buildCreditSpread({ chain: costly, price: 101, side: 'BULL_PUT', arm: 'B_STOCK' })
  assert.deepEqual(result, { ok: false, reason: 'CROSSING_COST_TOO_HIGH' })
})

test('rejects an illiquid protective leg', () => {
  const wide = [
    put(90, 1.00, 1.30, 0.20),
    put(95, 2.00, 2.20, 0.30),
    put(100, 4.00, 4.40, 0.50),
  ]
  const result = buildCreditSpread({ chain: wide, price: 101, side: 'BULL_PUT', arm: 'B_STOCK' })
  assert.deepEqual(result, { ok: false, reason: 'PROTECTIVE_LEG_ILLIQUID' })
})

test('rejects shorts whose leg spread exceeds the arm limit', () => {
  const loose = liquidPuts.map(leg => ({ ...leg, bid: leg.bid * 0.9 }))
  const result = buildCreditSpread({ chain: loose, price: 500, side: 'BULL_PUT', arm: 'A_INDEX' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'NO_LIQUID_SHORT_NEAR_TARGET_DELTA')
})

test('builds a bear call with the long strike above the short', () => {
  const calls = [
    call(510, 4.00, 4.02, 0.38),
    call(512, 3.20, 3.22, 0.31),
    call(513, 2.86, 2.88, 0.28),
    call(514, 2.55, 2.57, 0.25),
  ]
  const result = buildCreditSpread({ chain: calls, price: 500, side: 'BEAR_CALL', arm: 'A_INDEX' })
  assert.equal(result.ok, true)
  assert.equal(result.spread.short_strike, 512)
  assert.ok(result.spread.long_strike > result.spread.short_strike)
})

const position = {
  side: 'BULL_PUT', short_strike: 486, long_strike: 485, width: 1,
  entry_credit_natural: 0.28, max_loss: 0.72, expiry: '2026-11-27',
}

test('evaluateExit applies stop, take profit, time exit and hold in order', () => {
  assert.deepEqual(
    evaluateExit(position, { short_ask: 0.90, long_bid: 0.05, underlying: 487 }, '2026-11-02'),
    { action: 'CLOSE', reason: 'STOP', exitDebit: 0.85 })
  assert.deepEqual(
    evaluateExit(position, { short_ask: 0.20, long_bid: 0.07, underlying: 505 }, '2026-11-02'),
    { action: 'CLOSE', reason: 'TAKE_PROFIT', exitDebit: 0.13 })
  const time = evaluateExit(position, { short_ask: 0.30, long_bid: 0.10, underlying: 498 }, '2026-11-06')
  assert.equal(time.reason, 'TIME_21DTE')
  assert.equal(time.action, 'CLOSE')
  assert.equal(evaluateExit(position, { short_ask: 0.30, long_bid: 0.10, underlying: 498 }, '2026-11-02').action, 'HOLD')
  assert.equal(evaluateExit(position, { long_bid: 0.10, underlying: 498 }, '2026-11-02').action, 'NO_DATA')
})

test('expiry settles on the underlying, capped at the width', () => {
  assert.equal(settlementDebit(position, 490), 0)
  assert.equal(settlementDebit(position, 485.6), 0.4)
  assert.equal(settlementDebit(position, 470), 1)
  const bearCall = { side: 'BEAR_CALL', short_strike: 512, width: 2 }
  assert.equal(settlementDebit(bearCall, 513), 1)
  assert.deepEqual(evaluateExit(position, { underlying: 470 }, '2026-11-27'), { action: 'CLOSE', reason: 'EXPIRY', exitDebit: 1 })
})

test('computePnl charges entry fees always and exit fees unless expired worthless', () => {
  const worthless = computePnl(position, 0, 'EXPIRY')
  assert.equal(worthless.fees_dollars, 1.3)
  assert.equal(worthless.net_pnl_dollars, 26.7)
  assert.ok(Math.abs(worthless.return_on_risk - 26.7 / 73.3) < 1e-4)
  const stopped = computePnl(position, 0.85, 'STOP')
  assert.equal(stopped.fees_dollars, 2.6)
  assert.equal(stopped.net_pnl_dollars, -59.6)
})

test('earnings inside the holding window disqualify the trade', () => {
  assert.equal(hasEarningsBeforeExpiry('2026-11-05', '2026-10-19', '2026-11-27'), true)
  assert.equal(hasEarningsBeforeExpiry('2026-12-05', '2026-10-19', '2026-11-27'), false)
  assert.equal(hasEarningsBeforeExpiry(null, '2026-10-19', '2026-11-27'), false)
  assert.equal(hasEarningsBeforeExpiry('TBD', '2026-10-19', '2026-11-27'), false)
})
