// api/cron/resolve-trade-outcomes.js
//
// SCAFFOLD — item 2. NOT functional yet, deliberately. Parked behind item 1
// per session decision ("building app-wide win ratio from signal_history
// takes priority... the trades-resolver extension is real work, scoped, but
// parked"). This file exists so the design is captured and reviewable now,
// not to be deployed as-is.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE FILE, NOT A MODIFICATION TO resolve-outcomes.js
// ─────────────────────────────────────────────────────────────────────────
// signal_history and trades are structurally different in ways that matter:
//   - signal_history: pure-insert, no upsert, system-generated, one row per
//     scan hit. Resolution there answers "did the ENGINE's signal work."
//   - trades: user-curated (a user chose to log this one), can be manually
//     closed at any time by the user, and per the session's UX decision
//     for this item, resolution here should be SUGGEST-ONLY — flag "this
//     hit target, mark as closed?" and let the user confirm, never close
//     a trade out from under them automatically.
// That suggest-only requirement is a fundamentally different write pattern
// than resolve-outcomes.js's autonomous resolution, so sharing one file
// would mean an autonomous-vs-suggest branch buried inside shared logic —
// worse than two clear, separate files.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS NEEDS TO DO, ONCE BUILT FOR REAL
// ─────────────────────────────────────────────────────────────────────────
// 1. Query trades WHERE status = 'Open' AND target_price/stop_price are
//    NOT NULL (same precondition verdictCheck.js already established for
//    item 5 — REUSE that precondition check, don't reinvent it).
// 2. For each, walk forward from entry the same way resolve-outcomes.js's
//    findFirstThresholdHit does — but this raises a real open question NOT
//    yet decided: does this reuse buildOccSymbol + getOptionHistory/
//    getOptionTimesales (the historical-bar walk, same as
//    resolve-outcomes.js) for full accuracy, or does it piggyback on
//    verdict-check's cron (which ALREADY fetches a live quote for every
//    open trade every 15 min) and just check "did current_mid cross
//    target/stop" using data verdict-check already has in memory?
//    The second is far cheaper (zero new Tradier calls) but less precise
//    (catches the threshold cross only if it's still true at the moment
//    of a 15-min check, not the exact bar it happened on, unlike the
//    historical-walk approach). NOT DECIDED — flag for product discussion
//    before writing real logic here.
// 3. On a hit, do NOT update trades.status directly. Per suggest-only UX:
//    write to a new table (NOT YET DESIGNED — placeholder name below) so
//    the frontend can show "Tap to confirm: NVDA hit target at $X, mark
//    closed?" and only the user's explicit confirmation calls the existing
//    PUT /api/user/trades?id=X endpoint to actually close it.
//
// ─────────────────────────────────────────────────────────────────────────
// NOT YET DECIDED (placeholders below, not real names):
// ─────────────────────────────────────────────────────────────────────────
// - Table name for pending suggestions (placeholder: trade_close_suggestions)
// - Whether a suggestion expires/auto-dismisses if not acted on, or persists
//   until the user explicitly dismisses it
// - Whether this needs its own cron cadence or can ride along inside
//   verdict-check.js's existing 15-min loop (cheaper, per point 2 above,
//   if that approach is chosen)

module.exports = async function handler(req, res) {
  return res.status(501).json({
    error: 'Not implemented — item 2 scaffold only. See file header comments for design status and open decisions.',
  })
}
