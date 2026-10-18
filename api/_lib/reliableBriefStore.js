function isTransientStorageError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  const status = Number(error?.status || error?.statusCode || 0)
  return error?.name === 'AbortError'
    || [408, 502, 503, 504, 520, 522].includes(status)
    || /abort|timed?\s*out|timeout|fetch failed|network|connection/.test(message)
}

function normalizeError(error) {
  if (error instanceof Error) return error
  const normalized = new Error(error?.message || String(error || 'Unknown storage error'))
  if (error && typeof error === 'object') Object.assign(normalized, error)
  return normalized
}

async function storeBriefReliably({
  row,
  insertRow,
  findByGeneratedAt,
  attempts = 3,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
}) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await insertRow(row)
      if (!result?.error) return { row: result?.data || row, recoveredAfterTimeout: false, attempts: attempt + 1 }
      lastError = result.error
    } catch (error) {
      lastError = error
    }

    // A timed-out POST has an unknown outcome: Postgres may have committed it
    // even though the response never reached Vercel. Confirm before retrying.
    try {
      const existing = await findByGeneratedAt(row.generated_at)
      if (existing) return { row: existing, recoveredAfterTimeout: true, attempts: attempt + 1 }
    } catch (confirmError) {
      console.warn('[brief] write confirmation failed:', confirmError?.message || confirmError)
    }

    if (!isTransientStorageError(lastError) || attempt === attempts - 1) {
      throw normalizeError(lastError)
    }

    const backoffMs = Math.round(250 * (2 ** attempt) + random() * 150)
    console.warn(`[brief] transient storage failure; retrying in ${backoffMs}ms (attempt ${attempt + 2}/${attempts})`)
    await sleep(backoffMs)
  }

  throw normalizeError(lastError)
}

module.exports = { isTransientStorageError, storeBriefReliably }
