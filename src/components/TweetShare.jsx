import { useState } from "react";

// Admin Clerk ID - matches adminBypass.js
const ADMIN_CLERK_ID = "user_3EYMA65Nxj9g1WnfYXQ01xMk9hF";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPrompt(setup) {
  return `You are a copywriter for OptionsEdgeFlow, a premium options trading scanner at optionsedgeflow.com.

Write a single tweet (max 260 chars including the URL) about this options setup that:
1. Opens with a punchy hook about the trade — make it feel like a real trader spotted something
2. Shows 2–3 key stats inline (ticker, setup type, edge score, DTE, or IV rank — pick the most compelling)
3. Ends with a subtle tease that makes people want to see more setups like this, with the URL: optionsedgeflow.com
4. Includes 4–6 relevant hashtags on a new line at the end

Trade details:
- Ticker: ${setup.ticker}
- Setup: ${setup.setup || setup.strategy || "Options Spread"}
- Edge Score: ${setup.edgeScore || setup.edge_score}%
- DTE: ${setup.dte} days
- IV Rank: ${setup.ivRank || setup.iv_rank || "N/A"}
- Direction: ${setup.direction || "Neutral"}
- Profit Target: ${setup.profitTarget || setup.profit_target || "80"}%

Rules:
- No emojis overload — max 2 emojis
- Sound like a sharp trader, not a bot
- Never say "I" or "we" — write in 3rd person or impersonally
- Return ONLY the tweet text, nothing else`;
}

async function generateTweet(setup) {
  const response = await fetch("/api/tweet-generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setup }),
  });
  const data = await response.json();
  if (!data.tweet) throw new Error("No tweet returned");
  return data.tweet;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function TweetShare({ setup, userId }) {
  const [open, setOpen] = useState(false);
  const [tweet, setTweet] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Only render for admin
  if (userId !== ADMIN_CLERK_ID) return null;

  // Only show for high-conviction setups
  const edgeScore = setup.edgeScore || setup.edge_score || 0;
  if (edgeScore < 90) return null;

  async function handleOpen() {
    setOpen(true);
    setTweet("");
    setError("");
    setLoading(true);
    try {
      const generated = await generateTweet(setup);
      setTweet(generated);
    } catch (e) {
      setError("Failed to generate tweet. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setTweet("");
    setError("");
    setCopied(false);
  }

  function handlePostToX() {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=600,height=500");
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(tweet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleRegenerate() {
    setTweet("");
    setError("");
    setLoading(true);
    try {
      const generated = await generateTweet(setup);
      setTweet(generated);
    } catch (e) {
      setError("Failed to generate tweet. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const charCount = tweet.length;
  const overLimit = charCount > 280;

  return (
    <>
      {/* ── Trigger Button ── */}
      <button
        onClick={handleOpen}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid #1d9bf0",
          borderRadius: "6px",
          color: "#1d9bf0",
          fontSize: "12px",
          fontFamily: "Inter, sans-serif",
          fontWeight: 500,
          cursor: "pointer",
          transition: "all 0.15s ease",
          letterSpacing: "0.02em",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "#1d9bf015";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
        title="Share on X (Admin only)"
      >
        <XIcon />
        Share
      </button>

      {/* ── Modal Overlay ── */}
      {open && (
        <div
          onClick={handleClose}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "12px",
              padding: "28px",
              width: "100%",
              maxWidth: "520px",
              fontFamily: "Inter, sans-serif",
              boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <XIcon size={20} color="#1d9bf0" />
                <span style={{ color: "#e6edf3", fontSize: "16px", fontWeight: 600 }}>
                  Share on X
                </span>
                <span style={{
                  fontSize: "10px",
                  padding: "2px 7px",
                  background: "#00ff8820",
                  color: "#00ff88",
                  borderRadius: "4px",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                }}>
                  ADMIN
                </span>
              </div>
              <button
                onClick={handleClose}
                style={{ background: "none", border: "none", color: "#8b949e", cursor: "pointer", fontSize: "20px", lineHeight: 1, padding: "2px 6px" }}
              >
                ×
              </button>
            </div>

            {/* Setup pill */}
            <div style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 12px",
              background: "#0d1117",
              border: "1px solid #30363d",
              borderRadius: "6px",
              marginBottom: "16px",
            }}>
              <span style={{ color: "#00ff88", fontFamily: "IBM Plex Mono, monospace", fontSize: "13px", fontWeight: 600 }}>
                {setup.ticker}
              </span>
              <span style={{ color: "#8b949e", fontSize: "12px" }}>·</span>
              <span style={{ color: "#e6edf3", fontSize: "12px" }}>{setup.setup || setup.strategy || "Options Spread"}</span>
              <span style={{ color: "#8b949e", fontSize: "12px" }}>·</span>
              <span style={{ color: "#00ff88", fontFamily: "IBM Plex Mono, monospace", fontSize: "12px" }}>
                {edgeScore}% edge
              </span>
            </div>

            {/* Tweet area */}
            <div style={{ position: "relative", marginBottom: "12px" }}>
              {loading ? (
                <div style={{
                  minHeight: "140px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "12px",
                  background: "#0d1117",
                  borderRadius: "8px",
                  border: "1px solid #30363d",
                }}>
                  <Spinner />
                  <span style={{ color: "#8b949e", fontSize: "13px" }}>Generating tweet…</span>
                </div>
              ) : error ? (
                <div style={{
                  minHeight: "80px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#ff000010",
                  border: "1px solid #ff000040",
                  borderRadius: "8px",
                  color: "#ff7b7b",
                  fontSize: "13px",
                }}>
                  {error}
                </div>
              ) : (
                <textarea
                  value={tweet}
                  onChange={(e) => setTweet(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: "140px",
                    background: "#0d1117",
                    border: `1px solid ${overLimit ? "#ff000060" : "#30363d"}`,
                    borderRadius: "8px",
                    color: "#e6edf3",
                    fontSize: "14px",
                    lineHeight: "1.6",
                    padding: "14px",
                    resize: "vertical",
                    fontFamily: "Inter, sans-serif",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                  placeholder="Tweet will appear here…"
                />
              )}
            </div>

            {/* Char count + regen */}
            {!loading && !error && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "20px" }}>
                <button
                  onClick={handleRegenerate}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#8b949e",
                    fontSize: "12px",
                    cursor: "pointer",
                    padding: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  ↻ Regenerate
                </button>
                <span style={{
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: "12px",
                  color: overLimit ? "#ff7b7b" : charCount > 250 ? "#f0a500" : "#8b949e",
                }}>
                  {charCount}/280
                </span>
              </div>
            )}

            {/* Actions */}
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={handleCopy}
                disabled={!tweet || loading}
                style={{
                  flex: 1,
                  padding: "10px",
                  background: "transparent",
                  border: "1px solid #30363d",
                  borderRadius: "7px",
                  color: copied ? "#00ff88" : "#8b949e",
                  fontSize: "13px",
                  fontWeight: 500,
                  cursor: tweet && !loading ? "pointer" : "not-allowed",
                  transition: "all 0.15s",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                {copied ? "✓ Copied" : "Copy"}
              </button>
              <button
                onClick={handlePostToX}
                disabled={!tweet || loading || overLimit}
                style={{
                  flex: 2,
                  padding: "10px",
                  background: tweet && !loading && !overLimit ? "#1d9bf0" : "#1d9bf040",
                  border: "none",
                  borderRadius: "7px",
                  color: tweet && !loading && !overLimit ? "#fff" : "#ffffff60",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: tweet && !loading && !overLimit ? "pointer" : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "7px",
                  transition: "all 0.15s",
                  fontFamily: "Inter, sans-serif",
                }}
              >
                <XIcon size={14} color="currentColor" />
                Post to X
              </button>
            </div>

            <p style={{ color: "#8b949e", fontSize: "11px", textAlign: "center", marginTop: "14px", marginBottom: 0 }}>
              Opens X in a new window — you confirm before posting.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function XIcon({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.264 5.633L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function Spinner() {
  return (
    <div style={{
      width: "24px",
      height: "24px",
      border: "2px solid #30363d",
      borderTopColor: "#1d9bf0",
      borderRadius: "50%",
      animation: "spin 0.7s linear infinite",
    }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
