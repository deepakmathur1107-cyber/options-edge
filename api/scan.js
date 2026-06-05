/**
 * api/scan.js  — Vercel Serverless Function
 *
 * GET /api/scan?symbols=SPY,QQQ
 *
 * Auth:  Clerk JWT required (or admin bypass).
 * Gate:  Active Stripe subscription required (or admin bypass).
 * Data:  Tradier sandbox → options chain → compute edge score.
 */

import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import { isAdminServer } from "./_lib/adminBypass.js";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TRADIER_TOKEN = process.env.TRADIER_API_TOKEN;
const TRADIER_BASE = "https://sandbox.tradier.com/v1";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getUserId(req) {
  const authHeader = req.headers["authorization"] ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const payload = await clerk.verifyToken(token);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function hasActiveSubscription(userId) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("clerk_user_id", userId)
    .single();

  if (error || !data) return false;
  return ["active", "trialing"].includes(data.status);
}

async function fetchQuote(symbol) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/quotes?symbols=${symbol}&greeks=false`,
    {
      headers: {
        Authorization: `Bearer ${TRADIER_TOKEN}`,
        Accept: "application/json",
      },
    }
  );
  const json = await res.json();
  return json?.quotes?.quote ?? null;
}

async function fetchOptionsChain(symbol, expiration) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${expiration}&greeks=true`,
    {
      headers: {
        Authorization: `Bearer ${TRADIER_TOKEN}`,
        Accept: "application/json",
      },
    }
  );
  const json = await res.json();
  const options = json?.options?.option ?? [];
  return Array.isArray(options) ? options : [options];
}

async function fetchNearestExpiration(symbol) {
  const res = await fetch(
    `${TRADIER_BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=false`,
    {
      headers: {
        Authorization: `Bearer ${TRADIER_TOKEN}`,
        Accept: "application/json",
      },
    }
  );
  const json = await res.json();
  const dates = json?.expirations?.date ?? [];
  const arr = Array.isArray(dates) ? dates : [dates];
  // Return the expiration 7–45 DTE (skip weeklies < 7 days out)
  const today = Date.now();
  const filtered = arr.filter((d) => {
    const dte = (new Date(d) - today) / 86_400_000;
    return dte >= 7 && dte <= 45;
  });
  return filtered[0] ?? arr[1] ?? arr[0] ?? null;
}

function computeEdgeScore(option, underlyingPrice) {
  const { greeks, volume, open_interest, bid, ask } = option;
  if (!greeks || !bid || !ask) return null;

  const midpoint = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadPct = midpoint > 0 ? spread / midpoint : 1;
  const iv = greeks.smv_vol ?? greeks.bid_iv ?? 0;
  const delta = Math.abs(greeks.delta ?? 0);
  const theta = Math.abs(greeks.theta ?? 0);
  const oi = open_interest ?? 0;
  const vol = volume ?? 0;

  // Prefer 0.20–0.40 delta, high theta/premium ratio, tight spread, liquid
  const deltaScore = delta >= 0.2 && delta <= 0.4 ? 20 : delta >= 0.1 && delta <= 0.5 ? 10 : 0;
  const thetaScore = midpoint > 0 ? Math.min(20, (theta / midpoint) * 200) : 0;
  const spreadScore = spreadPct < 0.05 ? 20 : spreadPct < 0.10 ? 12 : spreadPct < 0.20 ? 6 : 0;
  const liquidityScore = oi > 500 && vol > 100 ? 20 : oi > 100 ? 10 : 0;
  const ivScore = iv > 0.15 && iv < 0.60 ? 20 : 0;

  return Math.round(deltaScore + thetaScore + spreadScore + liquidityScore + ivScore);
}

function pickBestContracts(chain, underlyingPrice, limit = 3) {
  return chain
    .map((opt) => ({ ...opt, edgeScore: computeEdgeScore(opt, underlyingPrice) }))
    .filter((o) => o.edgeScore !== null && o.edgeScore > 30)
    .sort((a, b) => b.edgeScore - a.edgeScore)
    .slice(0, limit)
    .map((o) => ({
      symbol: o.symbol,
      type: o.option_type,
      strike: o.strike,
      expiration: o.expiration_date,
      bid: o.bid,
      ask: o.ask,
      mid: +((o.bid + o.ask) / 2).toFixed(2),
      iv: o.greeks?.smv_vol ?? o.greeks?.bid_iv ?? null,
      delta: o.greeks?.delta ?? null,
      theta: o.greeks?.theta ?? null,
      volume: o.volume,
      openInterest: o.open_interest,
      edgeScore: o.edgeScore,
    }));
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth
  const userId = await getUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Subscription gate (admins bypass)
  if (!isAdminServer(userId)) {
    const subscribed = await hasActiveSubscription(userId);
    if (!subscribed) {
      return res.status(402).json({ error: "Subscription required" });
    }
  }

  // Parse symbols
  const rawSymbols = req.query.symbols ?? "SPY,QQQ";
  const symbols = rawSymbols
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 5); // cap at 5

  try {
    const results = await Promise.all(
      symbols.map(async (symbol) => {
        const [quote, expiration] = await Promise.all([
          fetchQuote(symbol),
          fetchNearestExpiration(symbol),
        ]);

        if (!quote || !expiration) {
          return { symbol, error: "Could not fetch quote or expiration" };
        }

        const price = quote.last ?? quote.close ?? null;
        const chain = await fetchOptionsChain(symbol, expiration);
        const contracts = pickBestContracts(chain, price);

        return {
          symbol,
          price,
          expiration,
          change: quote.change ?? null,
          changePct: quote.change_percentage ?? null,
          volume: quote.volume ?? null,
          contracts,
        };
      })
    );

    return res.status(200).json({ results, scannedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[scan] Error:", err);
    return res.status(500).json({ error: "Scan failed", detail: err.message });
  }
}
