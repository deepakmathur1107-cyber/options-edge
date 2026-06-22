import { useState } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchTweetAngles(result, getToken) {
  const token = await getToken?.().catch(() => null);
  const params = new URLSearchParams({
    action: "tweet",
    ticker: result.ticker || result.sym || "",
    tradeType: result.tradeType || "",
    strikeStr: result.strikeStr || "",
    score: String(result.score || 90),
    grade: result.grade || "A",
    dte: String(result.dte || ""),
    target: result.target || "",
    iv: result.iv || "",
  });
  const response = await fetch(`/api/brief?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Failed to generate tweets");
  if (!Array.isArray(data.tweets) || data.tweets.length === 0) throw new Error("No tweets returned");
  return data.tweets;
}

// ─── Main Component ──────────────────────────────────────────────────────────
// isAdmin comes from the same prop already threaded through App.jsx for
// every other admin-gated control (TG buttons, Admin nav tab) — not a
// hardcoded Clerk ID duplicated here and shipped to every browser bundle.

export default function TweetShare({ result, isAdmin, getToken, C }) {
  const [open, setOpen] = useState(false);
  const [tweets, setTweets] = useState([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  if (!isAdmin) return null;

  const score = result?.score || 0;
  if (score < 90) return null;

  async function handleOpen() {
    setOpen(true);
    setTweets([]);
    setSelected(0);
    setError("");
    setLoading(true);
    try {
      const generated = await fetchTweetAngles(result, getToken);
      setTweets(generated);
    } catch (e) {
      setError(e.message || "Failed to generate tweets. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setTweets([]);
    setError("");
    setCopied(false);
  }

  const activeTweet = tweets[selected] || "";

  function handlePostToX() {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(activeTweet)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=600,height=500");
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(activeTweet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const charCount = activeTweet.length;
  const overLimit = charCount > 280;
  const ANGLE_LABELS = ["Punchy hook", "Stat-led", "Story", "Question", "Contrarian", "Plain data"];

  return (
    <>
      {/* ── Trigger Button ── */}
      <button
        onClick={handleOpen}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 12px", background: "transparent",
          border: `1px solid ${C.blue}`, borderRadius: 6, color: C.blue,
          fontSize: 12, fontFamily: "Inter, sans-serif", fontWeight: 500,
          cursor: "pointer", letterSpacing: "0.02em",
        }}
        title="Share on X (Admin only)"
      >
        <XIcon /> Share
      </button>

      {/* ── Modal Overlay ── */}
      {open && (
        <div
          onClick={handleClose}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
            zIndex: 1000, display: "flex", alignItems: "center",
            justifyContent: "center", padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: C.card, border: `1px solid ${C.border}`,
              borderRadius: 12, padding: 28, width: "100%", maxWidth: 600,
              maxHeight: "85vh", overflowY: "auto",
              fontFamily: "Inter, sans-serif", boxShadow: C.shadowLg,
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <XIcon size={20} color={C.blue} />
                <span style={{ color: C.text, fontSize: 16, fontWeight: 600, fontFamily: "'Fraunces',serif" }}>Share on X</span>
                <span style={{ fontSize: 10, padding: "2px 7px", background: `${C.green}20`, color: C.green, borderRadius: 4, fontWeight: 600, letterSpacing: "0.05em" }}>ADMIN</span>
              </div>
              <button onClick={handleClose} style={{ background: "none", border: "none", color: C.dim, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "2px 6px" }}>×</button>
            </div>

            {/* Setup pill */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px", background: C.bgDeep, border: `1px solid ${C.border}`, borderRadius: 6, marginBottom: 16 }}>
              <span style={{ color: C.green, fontFamily: "IBM Plex Mono, monospace", fontSize: 13, fontWeight: 600 }}>${result?.ticker}</span>
              <span style={{ color: C.dim, fontSize: 12 }}>·</span>
              <span style={{ color: C.text, fontSize: 12 }}>{result?.tradeType} {result?.strikeStr}</span>
              <span style={{ color: C.dim, fontSize: 12 }}>·</span>
              <span style={{ color: C.green, fontFamily: "IBM Plex Mono, monospace", fontSize: 12 }}>{score}% conviction</span>
            </div>

            {loading ? (
              <div style={{ minHeight: 140, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, background: C.bgDeep, borderRadius: 8, border: `1px solid ${C.border}` }}>
                <Spinner C={C} />
                <span style={{ color: C.dim, fontSize: 13 }}>Generating 6 angles…</span>
              </div>
            ) : error ? (
              <div style={{ minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center", background: `${C.red}10`, border: `1px solid ${C.red}40`, borderRadius: 8, color: C.red, fontSize: 13, padding: 16, textAlign: "center" }}>
                {error}
              </div>
            ) : (
              <>
                {/* Angle picker — 6 cards */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14 }}>
                  {tweets.map((t, i) => (
                    <button
                      key={i}
                      onClick={() => setSelected(i)}
                      style={{
                        padding: "8px 6px", borderRadius: 6, cursor: "pointer",
                        border: `1px solid ${selected === i ? C.blue : C.border}`,
                        background: selected === i ? `${C.blue}15` : C.bgDeep,
                        color: selected === i ? C.blue : C.dim,
                        fontSize: 10.5, fontWeight: 600, textAlign: "center",
                      }}
                    >
                      {ANGLE_LABELS[i] || `Option ${i + 1}`}
                    </button>
                  ))}
                </div>

                {/* Selected tweet, editable */}
                <textarea
                  value={activeTweet}
                  onChange={(e) => setTweets(prev => prev.map((t, i) => i === selected ? e.target.value : t))}
                  style={{
                    width: "100%", minHeight: 120, background: C.bgDeep,
                    border: `1px solid ${overLimit ? C.red : C.border}`, borderRadius: 8,
                    color: C.text, fontSize: 14, lineHeight: 1.6, padding: 14,
                    resize: "vertical", fontFamily: "Inter, sans-serif", outline: "none",
                    boxSizing: "border-box", marginBottom: 10,
                  }}
                />

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
                  <button onClick={handleOpen} style={{ background: "none", border: "none", color: C.dim, fontSize: 12, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}>
                    ↻ Regenerate all 6
                  </button>
                  <span style={{ fontFamily: "IBM Plex Mono, monospace", fontSize: 12, color: overLimit ? C.red : charCount > 250 ? C.orange : C.dim }}>
                    {charCount}/280
                  </span>
                </div>

                {/* Actions */}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    onClick={handleCopy}
                    disabled={!activeTweet}
                    style={{
                      flex: 1, padding: 10, background: "transparent",
                      border: `1px solid ${C.border}`, borderRadius: 7,
                      color: copied ? C.green : C.dim, fontSize: 13, fontWeight: 500,
                      cursor: activeTweet ? "pointer" : "not-allowed", fontFamily: "Inter, sans-serif",
                    }}
                  >
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                  <button
                    onClick={handlePostToX}
                    disabled={!activeTweet || overLimit}
                    style={{
                      flex: 2, padding: 10,
                      background: activeTweet && !overLimit ? C.blue : `${C.blue}40`,
                      border: "none", borderRadius: 7,
                      color: "#ffffff", fontSize: 13, fontWeight: 600,
                      cursor: activeTweet && !overLimit ? "pointer" : "not-allowed",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
                      fontFamily: "Inter, sans-serif",
                    }}
                  >
                    <XIcon size={14} color="currentColor" /> Post to X
                  </button>
                </div>

                <p style={{ color: C.dim, fontSize: 11, textAlign: "center", marginTop: 14, marginBottom: 0 }}>
                  Opens X in a new window — you confirm before posting.
                </p>
              </>
            )}
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

function Spinner({ C }) {
  return (
    <div style={{ width: 24, height: 24, border: `2px solid ${C.border}`, borderTopColor: C.blue, borderRadius: "50%", animation: "spin 0.7s linear infinite" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
