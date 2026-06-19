// api/_lib/secretCrypto.js
// Small helper for encrypting sensitive values (like the admin Telegram bot
// token) before they're stored in Supabase, so a DB dump or leaked row never
// hands over a live, usable credential in plaintext.
//
// Requires SECRET_ENCRYPTION_KEY in Vercel env vars — a 32-byte key,
// base64-encoded. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Set it in Vercel → Project → Settings → Environment Variables.
//
// Uses AES-256-GCM: a random 12-byte IV per value, auth tag stored alongside
// so tampering is detectable, not just decryptable-or-not.

const crypto = require('crypto')

function getKey() {
  const b64 = process.env.SECRET_ENCRYPTION_KEY
  if (!b64) throw new Error('SECRET_ENCRYPTION_KEY not set')
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) throw new Error('SECRET_ENCRYPTION_KEY must decode to exactly 32 bytes')
  return key
}

// Returns a single string "iv:authTag:ciphertext" (all base64), safe to
// store directly in a text column.
function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return null
  const key = getKey()
  const iv  = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

// Reverses encryptSecret. Returns null on any failure (wrong key, tampered
// value, not actually encrypted) rather than throwing — callers should
// treat a null result the same as "no token configured."
function decryptSecret(stored) {
  if (!stored) return null
  try {
    const [ivB64, tagB64, dataB64] = stored.split(':')
    if (!ivB64 || !tagB64 || !dataB64) return null
    const key = getKey()
    const iv  = Buffer.from(ivB64, 'base64')
    const tag = Buffer.from(tagB64, 'base64')
    const data = Buffer.from(dataB64, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()])
    return plaintext.toString('utf8')
  } catch (e) {
    console.error('[secretCrypto] decrypt failed:', e.message)
    return null
  }
}

module.exports = { encryptSecret, decryptSecret }
