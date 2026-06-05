/**
 * src/pages/AlertSettings.jsx  (or src/components/AlertSettings.jsx)
 *
 * Alerts & notification preferences page.
 * Reads from GET /api/user/prefs  — saves to POST /api/user/prefs
 */

import { useState, useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";

const AVAILABLE_SYMBOLS = ["SPY", "QQQ", "IWM", "AAPL", "TSLA", "NVDA", "AMZN", "META"];

const DEFAULT_PREFS = {
  email_alerts: false,
  alert_email: "",
  min_edge_score: 50,
  symbols: ["SPY", "QQQ"],
};

export default function AlertSettings() {
  const { getToken } = useAuth();

  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  // ── Load prefs ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const token = await getToken();
        const res = await fetch("/api/user/prefs", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setPrefs({
          email_alerts: data.prefs.email_alerts ?? false,
          alert_email: data.prefs.alert_email ?? "",
          min_edge_score: data.prefs.min_edge_score ?? 50,
          symbols: data.prefs.symbols ?? ["SPY", "QQQ"],
        });
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [getToken]);

  // ── Save prefs ──────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const token = await getToken();
      const res = await fetch("/api/user/prefs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(prefs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ── Symbol toggle ───────────────────────────────────────────────────────────
  function toggleSymbol(sym) {
    setPrefs((p) => ({
      ...p,
      symbols: p.symbols.includes(sym)
        ? p.symbols.filter((s) => s !== sym)
        : [...p.symbols, sym],
    }));
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-zinc-400 text-sm">
        Loading preferences…
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8 space-y-4">
      <h1 className="text-xl font-semibold text-zinc-100 mb-6">Alert settings</h1>

      {/* ── Email alerts toggle ── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">
          Email alerts
        </p>

        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-medium text-zinc-100">Enable email alerts</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Get notified when high-edge contracts are found
            </p>
          </div>
          <button
            onClick={() => setPrefs((p) => ({ ...p, email_alerts: !p.email_alerts }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              prefs.email_alerts ? "bg-emerald-500" : "bg-zinc-700"
            }`}
            role="switch"
            aria-checked={prefs.email_alerts}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                prefs.email_alerts ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className={prefs.email_alerts ? "" : "opacity-40 pointer-events-none"}>
          <label className="block text-sm font-medium text-zinc-300 mb-1.5">
            Send alerts to
          </label>
          <input
            type="email"
            value={prefs.alert_email}
            onChange={(e) => setPrefs((p) => ({ ...p, alert_email: e.target.value }))}
            placeholder="you@example.com"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500"
          />
          <p className="text-xs text-zinc-500 mt-1.5">
            Emails sent weekdays at 9:00 am ET during market hours.
          </p>
        </div>
      </div>

      {/* ── Symbols ── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">
          Symbols to watch
        </p>
        <div className="flex flex-wrap gap-2">
          {AVAILABLE_SYMBOLS.map((sym) => {
            const active = prefs.symbols.includes(sym);
            return (
              <button
                key={sym}
                onClick={() => toggleSymbol(sym)}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  active
                    ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400"
                    : "bg-transparent border-zinc-700 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {sym}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Scanner runs on all selected symbols. At least one required.
        </p>
      </div>

      {/* ── Edge score threshold ── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-4">
          Minimum edge score
        </p>
        <div className="flex items-center gap-3 mb-2">
          <span className="text-sm text-zinc-400">Threshold</span>
          <input
            type="range"
            min={30}
            max={80}
            step={5}
            value={prefs.min_edge_score}
            onChange={(e) =>
              setPrefs((p) => ({ ...p, min_edge_score: parseInt(e.target.value) }))
            }
            className="flex-1 accent-emerald-500"
          />
          <span className="text-sm font-medium text-zinc-100 w-8 text-right">
            {prefs.min_edge_score}
          </span>
        </div>
        <div className="flex justify-between text-xs text-zinc-600">
          <span>30 — more alerts</span>
          <span>80 — fewer, higher quality</span>
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Only contracts scoring above this threshold trigger an alert.
        </p>
      </div>

      {/* ── Cron info ── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
          Schedule
        </p>
        <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-400">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
          </svg>
          Weekdays at 9:00 am ET &mdash;{" "}
          <code className="text-xs text-zinc-500 font-mono">0 14 * * 1-5</code> UTC
        </div>
        <p className="text-xs text-zinc-500 mt-2.5">
          To trigger manually:{" "}
          <code className="text-xs font-mono text-zinc-400">
            POST /api/alerts/send
          </code>{" "}
          with your <code className="text-xs font-mono text-zinc-400">x-cron-secret</code> header.
        </p>
      </div>

      {/* ── Save ── */}
      {error && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleSave}
          disabled={saving || prefs.symbols.length === 0}
          className="px-5 py-2.5 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-semibold rounded-lg text-sm transition-colors"
        >
          {saving ? "Saving…" : "Save preferences"}
        </button>
        {saved && (
          <span className="text-sm text-emerald-400 flex items-center gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
