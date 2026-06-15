import { useState } from "react";

async function generateTweets(setup, getToken) {
  const token = getToken ? await getToken().catch(() => null) : null;
  const res = await fetch("/api/brief?action=tweet", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ setup }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to generate tweets");
  return data.tweets; // array of {angle, tweet}
}

export default function TweetShare({ setup, isAdmin, getToken }) {
  const [open, setOpen]       = useState(false);
  const [variants, setVariants] = useState([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [copied, setCopied]   = useState(false);

  if (!isAdmin) return null;
  const edgeScore = setup.edgeScore || setup.edge_score || setup.score || 0;
  if (edgeScore < 90) return null;

  async function handleOpen() {
    setOpen(true);
    setVariants([]);
    setSelected(0);
    setError("");
    setLoading(true);
    try {
      const v = await generateTweets(setup, getToken);
      setVariants(v || []);
    } catch (e) {
      setError(e.message || "Failed to generate tweets");
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setVariants([]);
    setError("");
    setCopied(false);
  }

  async function handleRegenerate() {
    setVariants([]);
    setError("");
    setSelected(0);
    setLoading(true);
    try {
      const v = await generateTweets(setup, getToken);
      setVariants(v || []);
    } catch (e) {
      setError(e.message || "Failed to generate tweets");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    const tweet = variants[selected]?.tweet || "";
    await navigator.clipboard.writeText(tweet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handlePostToX() {
    const tweet = variants[selected]?.tweet || "";
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`,
      "_blank",
      "noopener,noreferrer,width=600,height=500"
    );
  }

  const activeTweet = variants[selected]?.tweet || "";
  const charCount   = activeTweet.length;
  const overLimit   = charCount > 280;

  return (
    <>
      {/* ── Trigger Button ── */}
      <button
        onClick={handleOpen}
        style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: "6px 12px",
          background: "transparent",
          border: "1px solid #1d9bf0",
          borderRadius: "6px",
          color: "#1d9bf0",
          fontSize: "12px",
          fontFamily: "Inter, sans-serif",
          fontWeight: 500,
          cursor: "pointer",
          transition: "background 0.15s",
          whiteSpace: "nowrap",
        }}
        onMouseEnter={e => e.currentTarget.style.background = "#1d9bf015"}
        onMouseLeave={e => e.currentTarget.style.background = "transparent"}
      >
        <XIcon /> Share on X
      </button>

      {/* ── Modal ── */}
      {open && (
        <div
          onClick={handleClose}
          style={{
            position: "fixed", inset: 0,
            background: "rgba(0,0,0,0.8)",
            zIndex: 1000,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "16px",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#161b22",
              border: "1px solid #30363d",
              borderRadius: "12px",
              padding: "24px",
              width: "100%", maxWidth: "620px",
              maxHeight: "90vh",
              overflowY: "auto",
              fontFamily: "Inter, sans-serif",
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <XIcon size={18} color="#1d9bf0" />
                <span style={{ color: "#e6edf3", fontSize: "15px", fontWeight: 600 }}>Share on X</span>
                <span style={{
                  fontSize: "10px", padding: "2px 7px",
                  background: "#00ff8820", color: "#00ff88",
                  borderRadius: "4px", fontWeight: 700, letterSpacing: "0.05em",
                }}>ADMIN</span>
              </div>
              <button onClick={handleClose} style={{ background: "none", border: "none", color: "#8b949e", cursor: "pointer", fontSize: "22px", lineHeight: 1, padding: "2px 8px" }}>×</button>
            </div>

            {/* Setup pill */}
            <div style={{
              display: "inline-flex", alignItems: "center", gap: "8px",
              padding: "5px 12px",
              background: "#0d1117", border: "1px solid #30363d", borderRadius: "6px",
              marginBottom: "20px", flexWrap: "wrap",
            }}>
              <span style={{ color: "#00ff88", fontFamily: "IBM Plex Mono, monospace", fontSize: "13px", fontWeight: 600 }}>{setup.ticker}</span>
              <span style={{ color: "#8b949e" }}>·</span>
              <span style={{ color: "#e6edf3", fontSize: "12px" }}>{setup.setup || setup.strategy || setup.tradeType || "Options Spread"}</span>
              <span style={{ color: "#8b949e" }}>·</span>
              <span style={{ color: "#00ff88", fontFamily: "IBM Plex Mono, monospace", fontSize: "12px" }}>{edgeScore}% edge</span>
            </div>

            {/* Loading */}
            {loading && (
              <div style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                justifyContent: "center", gap: "14px", padding: "48px 0",
              }}>
                <Spinner />
                <span style={{ color: "#8b949e", fontSize: "13px" }}>Generating 6 angles…</span>
              </div>
            )}

            {/* Error */}
            {!loading && error && (
              <div style={{
                padding: "16px", background: "#ff000010",
                border: "1px solid #ff000040", borderRadius: "8px",
                color: "#ff7b7b", fontSize: "13px", textAlign: "center", marginBottom: "16px",
              }}>
                {error}
              </div>
            )}

            {/* 6 angle cards */}
            {!loading && variants.length > 0 && (
              <>
                <div style={{ marginBottom: "6px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ color: "#8b949e", fontSize: "12px" }}>Pick an angle — click to select, then post</span>
                  <button onClick={handleRegenerate} style={{
                    background: "none", border: "none", color: "#8b949e",
                    fontSize: "12px", cursor: "pointer", padding: 0,
                  }}>↻ Regenerate all</button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "16px" }}>
                  {variants.map((v, i) => {
                    const isActive = selected === i;
                    const chars = v.tweet.length;
                    const over = chars > 280;
                    return (
                      <div
                        key={i}
                        onClick={() => setSelected(i)}
                        style={{
                          border: `1px solid ${isActive ? "#1d9bf0" : "#30363d"}`,
                          borderRadius: "8px",
                          padding: "12px 14px",
                          background: isActive ? "#1d9bf008" : "#0d1117",
                          cursor: "pointer",
                          transition: "all 0.12s",
                          position: "relative",
                        }}
                      >
                        {/* Angle label + char count */}
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                          <span style={{
                            fontSize: "10px", fontWeight: 700, letterSpacing: "0.06em",
                            color: isActive ? "#1d9bf0" : "#8b949e",
                            textTransform: "uppercase",
                          }}>
                            {isActive ? "✓ " : ""}{v.angle}
                          </span>
                          <span style={{
                            fontFamily: "IBM Plex Mono, monospace", fontSize: "10px",
                            color: over ? "#ff7b7b" : chars > 250 ? "#f0a500" : "#8b949e",
                          }}>{chars}/280</span>
                        </div>
                        {/* Tweet text */}
                        <p style={{
                          margin: 0,
                          fontSize: "13px",
                          lineHeight: "1.55",
                          color: isActive ? "#e6edf3" : "#8b949e",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}>
                          {v.tweet}
                        </p>
                      </div>
                    );
                  })}
                </div>

                {/* Actions */}
                <div style={{ display: "flex", gap: "10px" }}>
                  <button onClick={handleCopy} style={{
                    flex: 1, padding: "10px",
                    background: "transparent", border: "1px solid #30363d", borderRadius: "7px",
                    color: copied ? "#00ff88" : "#8b949e",
                    fontSize: "13px", fontWeight: 500, cursor: "pointer",
                    fontFamily: "Inter, sans-serif",
                  }}>
                    {copied ? "✓ Copied" : "Copy"}
                  </button>
                  <button onClick={handlePostToX} disabled={overLimit} style={{
                    flex: 2, padding: "10px",
                    background: overLimit ? "#1d9bf040" : "#1d9bf0",
                    border: "none", borderRadius: "7px",
                    color: overLimit ? "#ffffff60" : "#fff",
                    fontSize: "13px", fontWeight: 600,
                    cursor: overLimit ? "not-allowed" : "pointer",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "7px",
                    fontFamily: "Inter, sans-serif",
                  }}>
                    <XIcon size={13} color="currentColor" /> Post to X
                  </button>
                </div>

                <p style={{ color: "#8b949e", fontSize: "11px", textAlign: "center", marginTop: "12px", marginBottom: 0 }}>
                  Opens X in a new window — you confirm before anything posts.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function XIcon({ size = 14, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.264 5.633L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes oef-spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        width: "28px", height: "28px",
        border: "2px solid #30363d", borderTopColor: "#1d9bf0",
        borderRadius: "50%",
        animation: "oef-spin 0.7s linear infinite",
      }} />
    </>
  );
}
