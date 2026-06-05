/**
 * api/user/trades.js  — Vercel Serverless Function
 *
 * GET    /api/user/trades          → list trades for current user
 * POST   /api/user/trades          → create a trade
 * PUT    /api/user/trades?id=<id>  → update a trade (close, edit)
 * DELETE /api/user/trades?id=<id>  → delete a trade
 */

import { createClerkClient } from "@clerk/backend";
import { createClient } from "@supabase/supabase-js";
import { isAdminServer } from "../_lib/adminBypass.js";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getUserId(req) {
  const token = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const payload = await clerk.verifyToken(token);
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function hasActiveSubscription(userId) {
  if (isAdminServer(userId)) return true;
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("clerk_user_id", userId)
    .single();
  if (error || !data) return false;
  return ["active", "trialing"].includes(data.status);
}

export default async function handler(req, res) {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const subscribed = await hasActiveSubscription(userId);
  if (!subscribed) return res.status(402).json({ error: "Subscription required" });

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("clerk_user_id", userId)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ trades: data });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    const {
      symbol,
      option_type,     // 'call' | 'put'
      strategy,        // 'buy' | 'sell' | 'spread' | etc.
      strike,
      expiration,
      contracts,
      premium,         // per contract, in dollars
      notes,
    } = req.body ?? {};

    if (!symbol || !option_type || !strike || !expiration) {
      return res.status(400).json({ error: "symbol, option_type, strike, expiration required" });
    }

    const { data, error } = await supabase
      .from("trades")
      .insert({
        clerk_user_id: userId,
        symbol: symbol.toUpperCase(),
        option_type,
        strategy,
        strike: Number(strike),
        expiration,
        contracts: Number(contracts ?? 1),
        premium: premium != null ? Number(premium) : null,
        notes: notes ?? null,
        status: "open",
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ trade: data });
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  if (req.method === "PUT") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });

    const allowed = ["status", "close_price", "close_date", "notes", "contracts", "premium"];
    const updates = {};
    for (const key of allowed) {
      if (req.body?.[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    const { data, error } = await supabase
      .from("trades")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("clerk_user_id", userId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Trade not found" });
    return res.status(200).json({ trade: data });
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id required" });

    const { error } = await supabase
      .from("trades")
      .delete()
      .eq("id", id)
      .eq("clerk_user_id", userId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
