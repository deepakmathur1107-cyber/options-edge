-- Already applied via Supabase MCP, included for reference.
ALTER TABLE signal_history
  ADD COLUMN IF NOT EXISTS last_walked_through date;
