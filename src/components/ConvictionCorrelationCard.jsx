import { useState, useEffect } from 'react';

// ── Conviction Correlation card. Shown on Dash, directly below Track
// Record — same data source (signal_history), same honest-empty-state
// philosophy, but answers a different question: does a higher conviction
// score actually predict a better outcome, not just "what's our overall
// win rate." Backed by /api/conviction-correlation (public, no auth, same
// reasoning as TrackRecordCard — aggregate non-personal data).
//
// Bucket tiers (85+ / 70-84 / 50-69) match the same conviction tiers
// TradeLog.jsx's own backtest view already uses (hi90/hi70/lo70) — same
// definition surfaced in two places, not two different ones a user could
// notice disagree.
//
// Per-bucket status can differ — one tier might have enough resolved
// signals for a real percentage while another is still low-sample. Each
// row renders its own honest state rather than forcing one pooled status
// across all three.

export default function ConvictionCorrelationCard({ C }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/conviction-correlation')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => { if (!cancelled) setData(json); })
      .catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true };
  }, []);

  // Silent on error or while loading — same reasoning as TrackRecordCard,
  // this is a confidence signal, not critical path.
  if (error || !data) return null;

  const { status, buckets } = data;

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
        CONVICTION VS OUTCOME · does a higher score actually win more
      </div>

      {status === 'accumulating' && (
        <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5 }}>
          Still accumulating data — once enough signals resolve, this will
          show whether higher-conviction signals actually win more often.
          Check back soon.
        </div>
      )}

      {status === 'ready' && (
        <div>
          {buckets.map((b, i) => (
            <div key={b.id} style={{
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
              gap: 10, padding: '7px 0',
              borderTop: i === 0 ? 'none' : `1px solid ${C.border}`,
            }}>
              <span style={{ fontSize: 12, color: C.text, fontFamily: "'IBM Plex Mono',monospace" }}>
                {b.label}
              </span>

              {b.status === 'ready' ? (
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{
                    fontFamily: "'Fraunces',serif", fontWeight: 600, fontSize: 18,
                    color: b.winRatePct >= 50 ? C.green : C.orange,
                  }}>
                    {b.winRatePct}%
                  </span>
                  <span style={{ fontSize: 11, color: C.dim }}>
                    {b.wins}W / {b.losses}L · {b.n} resolved
                  </span>
                </span>
              ) : b.status === 'low_sample' ? (
                <span style={{ fontSize: 12, color: C.dim }}>
                  {b.wins} of {b.n} resolved so far · too few for a rate yet
                </span>
              ) : (
                <span style={{ fontSize: 12, color: C.dim }}>
                  still accumulating
                </span>
              )}
            </div>
          ))}

          <div style={{ fontSize: 11, color: C.dim, marginTop: 10 }}>
            Same win/loss definition as Track Record above — only a clean
            target-hit counts as a win.
          </div>
        </div>
      )}
    </div>
  );
}
