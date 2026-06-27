import { useState, useEffect } from 'react';

// ── Track Record card — item 1. Engine-wide win rate, shown on Dash.
// Backed by /api/track-record (public, no auth — this is a stat shown to
// any user, not admin-only data). Three states, all built to be honest
// rather than impressive: accumulating (0 resolved), low_sample (some
// resolved but n too small for a percentage to mean anything), ready (a
// real percentage). Never fabricates a number; never shows 0% when n=0
// (that would read as "this engine has a 0% win rate," which is false —
// it has NO recorded outcomes yet, a different claim entirely).

export default function TrackRecordCard({ C }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/track-record')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => { if (!cancelled) setData(json); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true };
  }, []);

  // Silent on error or while loading -- this card is a nice-to-have
  // confidence signal, not critical path. A failed fetch shouldn't show a
  // red error box on the main Dash view the way an admin table would;
  // it should just not render, same as if the data weren't ready yet.
  if (error || !data) return null;

  const { status, n, wins, losses, winRatePct } = data;

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
      padding: '16px 20px', marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 10,
        letterSpacing: 1, textTransform: 'uppercase', color: C.dim,
        fontWeight: 700, marginBottom: 10,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
        TRACK RECORD · resolved signal outcomes
      </div>

      {status === 'accumulating' && (
        <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5 }}>
          Still accumulating data — every signal this engine generates is
          tracked against real market data, and a track record will appear
          here once enough signals have resolved. Check back soon.
        </div>
      )}

      {status === 'low_sample' && (
        <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>
          <strong style={{ fontFamily: "'Fraunces',serif", fontSize: 20 }}>{wins} of {n}</strong>
          {' '}resolved signals hit target so far.
          <span style={{ color: C.dim, fontSize: 12, display: 'block', marginTop: 4 }}>
            Still a small sample — showing raw counts rather than a percentage until there's enough history for a rate to be meaningful.
          </span>
        </div>
      )}

      {status === 'ready' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{
              fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 28,
              color: winRatePct >= 50 ? C.green : C.orange,
            }}>
              {winRatePct}%
            </span>
            <span style={{ fontSize: 12, color: C.dim }}>
              win rate · {wins}W / {losses}L · {n} resolved signals
            </span>
          </div>
          <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>
            Only a clean target-hit counts as a win — losses, partial expiries, and flat expiries all count against the rate.
          </div>
        </div>
      )}
    </div>
  );
}
