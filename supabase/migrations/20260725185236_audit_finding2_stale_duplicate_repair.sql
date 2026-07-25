-- Audit Finding 2 data repair: propagate the dead-letter PRIMARY row's
-- terminal values across every non-primary row in the same lifecycle that
-- was never individually repaired. Does NOT invent an outcome — outcome
-- stays null, matching the primary's own state exactly.
update public.signal_history dup
set
  resolution_method = p.resolution_method,
  resolved_at = p.resolved_at,
  resolve_attempts = p.resolve_attempts
from public.signal_history p
where p.is_lifecycle_primary is true
  and p.resolution_method = 'data_unavailable'
  and p.resolved_at is not null
  and dup.signal_lifecycle_id = p.signal_lifecycle_id
  and dup.is_lifecycle_primary is false
  and dup.resolved_at is null;
