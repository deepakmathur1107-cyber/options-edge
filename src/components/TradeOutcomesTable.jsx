import { useState, useEffect, useCallback } from 'react';

// ── Trade Outcomes table — sibling to SignalOutcomesTable.jsx, same admin
// section. Shows resolved (and unresolved) trade_outcomes rows, joined with
// the originating trades row for ticker/strike/etc. Backed by
// /api/admin/trade-outcomes — see that file for the query contract.
//
// Deliberately mirrors SignalOutcomesTable.jsx's structure closely rather
// than sharing a single generic component — these answer the same KIND of
// question (resolved-outcome win rate) but over genuinely different source
// tables with different join shapes (trade_outcomes needs trades joined in
// for display fields; signal_history is already flat), so a shared
// abstraction would need conditional logic for that difference anyway.
// Keeping them as parallel, independently-readable files was judged simpler
// than a shared component with a join-shape branch inside it.

const OUTCOME_STYLE = {
  WIN:             { label: 'WIN',     bg: 'green' },
  LOSS:            { label: 'LOSS',    bg: 'red' },
  EXPIRED_PARTIAL: { label: 'PARTIAL', bg: 'orange' },
  EXPIRED_FLAT:    { label: 'FLAT',    bg: 'dim' },
};

function OutcomeBadge({ outcome, C }) {
  if (!outcome) {
    return (
      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 500, background: C.cardAlt, color: C.dim }}>
        OPEN
      </span>
    );
  }
  const s = OUTCOME_STYLE[outcome];
  if (!s) return <span style={{ fontSize: 10, color: C.dim }}>{outcome}</span>;
  const color = C[s.bg] || C.dim;
  return (
    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, fontWeight: 600, background: `${color}20`, color, letterSpacing: 0.3 }}>
      {s.label}
    </span>
  );
}

function SortableHeader({ label, column, sortBy, sortDir, onSort, C, align }) {
  const active = sortBy === column;
  return (
    <th
      onClick={() => onSort(column)}
      style={{
        textAlign: align || 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600,
        letterSpacing: 0.4, textTransform: 'uppercase', color: active ? C.text : C.dim,
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      {label}{active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
}

export default function TradeOutcomesTable({ getToken, theme }) {
  const C = theme || {};
  const resolvedGetToken = getToken || (async () => null);

  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('created_at');
  const [sortDir, setSortDir] = useState('desc');
  const [outcomeFilter, setOutcomeFilter] = useState('');
  const [tickerFilter, setTickerFilter] = useState('');
  const [tickerInput, setTickerInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await resolvedGetToken();
      const params = new URLSearchParams({
        page: String(page), pageSize: '50', sortBy, sortDir,
      });
      if (outcomeFilter) params.set('outcome', outcomeFilter);
      if (tickerFilter) params.set('ticker', tickerFilter);

      const res = await fetch(`/api/admin/trade-outcomes?${params}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const json = await res.json();
      setRows(json.rows || []);
      setPagination(json.pagination);
      setStats(json.stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sortBy, sortDir, outcomeFilter, tickerFilter]);

  useEffect(() => { load(); }, [load]);

  const onSort = (column) => {
    if (sortBy === column) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column); setSortDir('desc');
    }
    setPage(1);
  };

  const applyTickerFilter = () => {
    setTickerFilter(tickerInput.trim().toUpperCase());
    setPage(1);
  };

  const selectStyle = {
    fontSize: 12, padding: '6px 10px', borderRadius: 6,
    border: `1px solid ${C.border}`, background: C.cardAlt, color: C.text,
  };

  const cell = { padding: '8px 10px', fontSize: 12, color: C.text, whiteSpace: 'nowrap' };

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <select value={outcomeFilter} onChange={e => { setOutcomeFilter(e.target.value); setPage(1); }} style={selectStyle}>
          <option value="">All outcomes</option>
          <option value="WIN">Win</option>
          <option value="LOSS">Loss</option>
          <option value="EXPIRED_PARTIAL">Expired (partial)</option>
          <option value="EXPIRED_FLAT">Expired (flat / decay)</option>
          <option value="UNRESOLVED">Still open</option>
        </select>
        <input
          value={tickerInput}
          onChange={e => setTickerInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && applyTickerFilter()}
          placeholder="Ticker…"
          style={{ ...selectStyle, width: 100 }}
        />
        <button onClick={applyTickerFilter} style={{ ...selectStyle, cursor: 'pointer' }}>Filter</button>
        {tickerFilter && (
          <button
            onClick={() => { setTickerFilter(''); setTickerInput(''); setPage(1); }}
            style={{ ...selectStyle, cursor: 'pointer', color: C.dim }}
          >
            ✕ {tickerFilter}
          </button>
        )}
        <button onClick={load} disabled={loading} style={{ ...selectStyle, cursor: 'pointer', marginLeft: 'auto' }}>
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
      </div>

      {/* Stats summary */}
      {stats && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
          <span style={{ color: C.text, fontWeight: 600 }}>
            Win rate: {stats.winRate !== null ? `${stats.winRate}%` : '—'}
            <span style={{ color: C.dim, fontWeight: 400 }}> ({stats.wins}W / {stats.lossesForRate}L total — {stats.losses} actual stop-outs, {stats.expiredPartial + stats.expiredFlat} counted as losses from expiry/decay)</span>
          </span>
          <span style={{ color: C.dim }}>Partial: {stats.expiredPartial}</span>
          <span style={{ color: C.dim }}>Flat/decay: {stats.expiredFlat}</span>
          <span style={{ color: C.dim }}>Open: {stats.unresolved}</span>
          <span style={{ color: C.dim }}>Total in filter: {stats.totalInFilter}</span>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: C.red, background: `${C.red}12`, border: `1px solid ${C.red}30`, borderRadius: 6, padding: '10px 12px', marginBottom: 10 }}>
          Error: {error}
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}`, borderRadius: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
          <thead style={{ background: C.bgAlt, borderBottom: `1px solid ${C.border}` }}>
            <tr>
              <SortableHeader label="Ticker" column="ticker" sortBy={sortBy} sortDir={sortDir} onSort={onSort} C={C} />
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: C.dim }}>Type</th>
              <SortableHeader label="Logged" column="created_at" sortBy={sortBy} sortDir={sortDir} onSort={onSort} C={C} />
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: C.dim }}>Outcome</th>
              <SortableHeader label="P&L %" column="pnl_pct_at_expiry" sortBy={sortBy} sortDir={sortDir} onSort={onSort} C={C} align="right" />
              <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 10.5, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase', color: C.dim }}>Method</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr><td colSpan={6} style={{ ...cell, textAlign: 'center', color: C.dim, padding: '20px 10px' }}>No trades match this filter</td></tr>
            )}
            {rows.map((r) => {
              const t = r.trades || {};
              return (
                <tr key={r.id} style={{ borderBottom: `1px solid ${C.border}20` }}>
                  <td style={{ ...cell, fontWeight: 600, color: C.blue, fontFamily: "'IBM Plex Mono', monospace" }}>{t.ticker || '—'}</td>
                  <td style={{ ...cell, color: (t.option_type || '').toLowerCase().includes('put') ? C.red : C.green }}>{t.option_type || '—'}</td>
                  <td style={{ ...cell, color: C.dim, fontSize: 11 }}>{r.created_at ? new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                  <td style={cell}><OutcomeBadge outcome={r.outcome} C={C} /></td>
                  <td style={{ ...cell, textAlign: 'right', color: r.pnl_pct_at_expiry > 0 ? C.green : r.pnl_pct_at_expiry < 0 ? C.red : C.dim, fontFamily: "'IBM Plex Mono', monospace" }}>
                    {r.pnl_pct_at_expiry !== null && r.pnl_pct_at_expiry !== undefined ? `${(r.pnl_pct_at_expiry * 100).toFixed(0)}%` : '—'}
                  </td>
                  <td style={{ ...cell, color: C.dim, fontSize: 11 }}>{r.resolution_method || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 12 }}>
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
            style={{ ...selectStyle, cursor: page <= 1 ? 'default' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}
          >
            ← Prev
          </button>
          <span style={{ fontSize: 12, color: C.dim }}>
            Page {pagination.page} of {pagination.totalPages} ({pagination.totalRows} total)
          </span>
          <button
            onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
            disabled={page >= pagination.totalPages}
            style={{ ...selectStyle, cursor: page >= pagination.totalPages ? 'default' : 'pointer', opacity: page >= pagination.totalPages ? 0.5 : 1 }}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
