function createBoundedFetch(timeoutMs = 8000) {
  return async function boundedFetch(input, init = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const upstreamSignal = init.signal
    const abortFromUpstream = () => controller.abort()
    if (upstreamSignal) {
      if (upstreamSignal.aborted) controller.abort()
      else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true })
    }
    try {
      return await fetch(input, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
      upstreamSignal?.removeEventListener?.('abort', abortFromUpstream)
    }
  }
}

module.exports = { createBoundedFetch }
