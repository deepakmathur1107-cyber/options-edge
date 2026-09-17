function isCronRequest(req, secret = process.env.CRON_SECRET) {
  if (!secret) return false
  return req.headers.authorization === `Bearer ${secret}`
    || req.headers['x-cron-secret'] === secret
}

module.exports = { isCronRequest }
