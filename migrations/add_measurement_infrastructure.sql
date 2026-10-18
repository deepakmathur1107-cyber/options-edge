-- Already applied via Supabase MCP, included for reference.
ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS direction_correct boolean,
  ADD COLUMN IF NOT EXISTS scoring_model_version text,
  ADD COLUMN IF NOT EXISTS entry_spread_pct numeric;

CREATE TABLE IF NOT EXISTS experiment_ledger (
  id bigint generated always as identity primary key,
  experiment_name text NOT NULL,
  hypothesis text NOT NULL,
  date_registered date NOT NULL,
  dataset_scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('shadow_testing','tested_rejected','tested_deployed','tested_inconclusive','deferred')),
  result_summary text,
  decision text,
  notes text,
  created_at timestamptz DEFAULT now()
);

-- direction_correct backfilled for 3,226 already-resolved rows at
-- migration time. Populated for all future resolutions automatically via
-- resolve-outcomes.js.
