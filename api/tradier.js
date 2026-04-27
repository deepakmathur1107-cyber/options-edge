// api/tradier.js — Vercel serverless proxy for Tradier API
// Runs server-side so no CORS issues

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tradier-token, x-tradier-mode');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const tradierPath = req.query.path;
  if (!tradierPath) {
    res.status(400).json({ error: 'Missing ?path= query param' });
    return;
  }

  // Token comes from Vercel env var (preferred) or request header (fallback)
  const token = process.env.TRADIER_TOKEN || req.headers['x-tradier-token'];
  if (!token) {
    res.status(401).json({ error: 'No Tradier token. Set TRADIER_TOKEN in Vercel env vars.' });
    return;
  }

  const mode = process.env.TRADIER_MODE || req.headers['x-tradier-mode'] || 'production';
  const base = mode === 'sandbox'
    ? 'https://sandbox.tradier.com/v1'
    : 'https://api.tradier.com/v1';

  // Forward all query params except 'path' to Tradier
  const params = new URLSearchParams(req.query);
  params.delete('path');
  const qs = params.toString();
  const url = `${base}${tradierPath}${qs ? '?' + qs : ''}`;

  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { data = { raw: text }; }

    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
