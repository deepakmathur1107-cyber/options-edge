/**
 * src/lib/adminBypass.js
 * Client-side admin check using VITE env var.
 * Mirror of api/_lib/adminBypass.js — kept separate because
 * server files use CommonJS (require/module.exports) and can't
 * be imported directly into Vite/React ESM bundles.
 */
const ADMIN_IDS = (import.meta.env.VITE_ADMIN_CLERK_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

export function isAdmin(userId) {
  return !!userId && ADMIN_IDS.includes(userId)
}
