-- Already applied via Supabase MCP, included for reference.
ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS strategy_version text,
  ADD COLUMN IF NOT EXISTS strategy_classification text,
  ADD COLUMN IF NOT EXISTS strategy_qualified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualification_reasons jsonb,
  ADD COLUMN IF NOT EXISTS qualification_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS shadow_mode boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS planned_risk_pct numeric,
  ADD COLUMN IF NOT EXISTS planned_risk_reward numeric;

-- experiment_ledger entry (swing_call_v1_forward_validation) also already
-- inserted via Supabase MCP.
