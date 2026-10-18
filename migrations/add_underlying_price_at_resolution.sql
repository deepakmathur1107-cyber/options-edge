-- Adds underlying_price_at_resolution to signal_history.
--
-- WHY: verdict/outcome analysis needs to distinguish a genuine wrong-direction
-- loss (stock moved against the position) from a theta/IV-decay loss (stock
-- moved favorably or flat but the option still bled to the stop). We already
-- store underlying_price at ENTRY (scan time); this captures the underlying's
-- price at the moment the outcome resolved, so the entry-vs-exit stock move is
-- natively recorded going forward instead of reconstructed retroactively.
--
-- Nullable, no default: existing rows legitimately don't have it, and a NULL is
-- the honest representation of "not captured" rather than a fabricated 0.

ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS underlying_price_at_resolution numeric;
