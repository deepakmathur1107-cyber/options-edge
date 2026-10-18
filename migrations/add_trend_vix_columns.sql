-- Adds long-term trend + VIX columns to signal_history, supporting the
-- 2026-07-18 counter-trend dampener (see convictionScore.cjs TF_WEIGHT_PROFILES
-- comment) and the VIX log-only capture (trendContext.js).
--
-- long_term_trend: 'bullish' | 'bearish' | 'mixed' | 'unknown', from SMA50/
--   SMA200 classification at scan time. Feeds the counter-trend scoring
--   dampener for Swing/LEAP/Deep LEAP.
-- vix_level / vix_chg_pct: LOG ONLY, not wired into scoring yet — needs its
--   own log-first-then-validate period against real resolved outcomes before
--   it earns a place in the formula, same discipline as regime_spx_chg_pct.
--
-- All nullable, no default — NULL is the honest state for existing rows
-- scanned before this feature existed (same pattern as regime_spx_chg_pct).

ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS long_term_trend text,
  ADD COLUMN IF NOT EXISTS vix_level numeric,
  ADD COLUMN IF NOT EXISTS vix_chg_pct numeric;
