/**
 * api/_lib/adminBypass.js
 * Server-side admin check for Vercel API routes.
 * Prefixed with _ so Vercel does NOT treat it as an endpoint.
 */
 
export function isAdminServer(userId) {
  if (!userId) return false;
  const raw = process.env.ADMIN_CLERK_IDS ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(userId);
}
