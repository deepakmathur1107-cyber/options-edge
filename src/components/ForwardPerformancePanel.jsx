import { useCallback, useEffect, useState } from 'react'

const pct = value => value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`
const num = value => value == null ? '—' : Number(value).toFixed(2)

const GATE_LABELS = {
  sampleSize: 'Resolved sample',
  cohortCount: 'Non-overlapping cohorts',
  positiveExpectancy: 'Positive expectancy',
  profitFactor: 'Profit factor',
  winRate: 'Win rate',
  maximumDrawdown: 'Maximum drawdown',
  cohortStability: 'Cohort stability',
  tickerConcentration: 'Ticker concentration',
  sectorConcentration: 'Sector concentration',
}

const SHADOW_STRATEGY_COPY = {
  regime_aligned_v2a: {
    name: 'Trade with the long-term trend',
    description: 'Tests calls in bullish trends and puts in bearish trends.',
  },
  entry_confirmation_v2b: {
    name: 'Wait for price confirmation',
    description: 'Tests entering only after the stock starts moving in the expected direction.',
  },
  liquidity_gate_v2c: {
    name: 'Only use liquid options',
    description: 'Requires a reasonable spread, trading volume, and open interest.',
  },
  combined_quality_v2d: {
    name: 'Require every quality check',
    description: 'Combines trend alignment, price confirmation, and option liquidity.',
  },
  defined_risk_spread_v2e: {
    name: 'Use a defined-risk spread',
    description: 'Compares a vertical spread with the current single-option trade.',
  },
}

function gateTarget(gate, gates) {
  const targets = {
    sampleSize: `${gates.minimumResolved} resolved`,
    cohortCount: `${gates.minimumCohorts} cohorts`,
    positiveExpectancy: `≥ ${gates.minimumExpectancyR}R`,
    profitFactor: `≥ ${gates.minimumProfitFactor}`,
    winRate: `≥ ${pct(gates.minimumWinRate)}`,
    maximumDrawdown: `≤ ${gates.maximumDrawdownR}R`,
    cohortStability: `30+ results and positive expectancy per cohort`,
    tickerConcentration: `≤ ${pct(gates.maximumTickerConcentration)}`,
    sectorConcentration: `≤ ${pct(gates.maximumSectorConcentration)}`,
  }
  return targets[gate] || ''
}

export default function ForwardPerformancePanel({ getToken, theme: C }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const token = await getToken()
      const response = await fetch('/api/admin/forward-performance', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      setData(body)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [getToken])

  useEffect(() => { load() }, [load])

  const measured = data?.resolvedWithExecutionMetrics || 0
  const minimumResolved = data?.promotion?.gates?.minimumResolved || 300
  const progress = Math.min(100, (measured / minimumResolved) * 100)
  const noForwardData = data && data.enrolled === 0
  const cards = data ? [
    ['Enrolled', data.enrolled],
    ['Measured', measured],
    ['Expectancy', data.promotion.metrics.expectancyR == null ? '—' : `${num(data.promotion.metrics.expectancyR)}R`],
    ['Profit factor', num(data.promotion.metrics.profitFactor)],
    ['Win rate', pct(data.promotion.metrics.winRate)],
    ['Cohorts', data.promotion.metrics.cohorts],
  ] : []

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,gap:10}}>
        <div style={{fontSize:11,color:C.dim,lineHeight:1.5}}>
          Forward-only, execution-adjusted Qualified V1 evidence. Historical and research-only signals are excluded.
        </div>
        <button onClick={load} disabled={loading} style={{background:`${C.blue}18`,border:`1px solid ${C.blue}45`,color:C.blue,padding:'5px 12px',borderRadius:4,cursor:'pointer'}}>
          {loading ? 'LOADING…' : 'REFRESH'}
        </button>
      </div>
      {error && <div style={{color:C.red,fontSize:11,marginBottom:10}}>Could not load forward performance: {error}</div>}
      {loading && !data && (
        <div aria-label="Loading forward performance" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:8,marginBottom:12}}>
          {[1,2,3,4,5,6].map(key => <div key={key} style={{height:62,background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:5,opacity:0.65}} />)}
        </div>
      )}
      {noForwardData && (
        <div style={{background:`${C.blue}0D`,border:`1px solid ${C.blue}35`,borderRadius:6,padding:'12px 14px',marginBottom:12}}>
          <div style={{fontSize:12,color:C.text,fontWeight:700,marginBottom:4}}>Forward validation starts with the next regular market session</div>
          <div style={{fontSize:10.5,color:C.dim,lineHeight:1.55}}>
            No LIVE_AT_SIGNAL recommendations have enrolled yet. Monday’s qualifying signals will enter the cohort automatically; promotion remains locked until enough execution-adjusted outcomes exist.
          </div>
        </div>
      )}
      {data && <>
        <div style={{marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:10.5,color:C.dim,marginBottom:5}}>
            <span>Promotion evidence</span>
            <span style={{fontFamily:"'IBM Plex Mono',monospace"}}>{measured} / {minimumResolved} resolved · {progress.toFixed(0)}%</span>
          </div>
          <div style={{height:7,background:C.border,borderRadius:4,overflow:'hidden'}}>
            <div style={{width:`${progress}%`,height:'100%',background:C.green,borderRadius:4,transition:'width .4s ease'}} />
          </div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(120px,1fr))',gap:8,marginBottom:12}}>
          {cards.map(([label,value]) => (
            <div key={label} style={{background:C.bgDeep,border:`1px solid ${C.border}`,borderRadius:5,padding:10}}>
              <div style={{fontSize:9,color:C.dim,letterSpacing:1}}>{label.toUpperCase()}</div>
              <div style={{fontSize:18,color:C.text,fontWeight:700,marginTop:3}}>{value}</div>
            </div>
          ))}
        </div>
        <div style={{fontSize:11,fontWeight:700,color:data.promotion.eligible?C.green:C.orange,marginBottom:8}}>
          {data.promotion.eligible ? 'ELIGIBLE FOR HUMAN PROMOTION REVIEW' : data.promotion.status.replaceAll('_',' ')}
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:6,marginBottom:12}}>
          {Object.entries(data.promotion.checks).map(([gate,passed]) => {
            const pending = measured === 0
            const color = passed ? C.green : pending ? C.dim : C.red
            return (
              <div key={gate} style={{fontSize:10.5,color,border:`1px solid ${C.border}`,borderRadius:4,padding:'7px 8px'}}>
                <div style={{display:'flex',justifyContent:'space-between',gap:8}}>
                  <span>{GATE_LABELS[gate] || gate}</span>
                  <span style={{fontWeight:700}}>{passed ? 'PASS' : pending ? 'PENDING' : 'FAIL'}</span>
                </div>
                <div style={{fontSize:9.5,color:C.dim,marginTop:3}}>{gateTarget(gate, data.promotion.gates)}</div>
              </div>
            )
          })}
        </div>
        <div style={{fontSize:12,fontWeight:700,color:C.text,marginBottom:3}}>Strategies being tested</div>
        <div style={{fontSize:10.5,color:C.dim,marginBottom:8,lineHeight:1.5}}>
          These ideas are measured in the background only. They do not change recommendations shown to users.
        </div>
        {(data.shadowStrategies||[]).length === 0
          ? <div style={{fontSize:11,color:C.dim}}>Waiting for enough new signals to begin testing.</div>
          : data.shadowStrategies.map(row => {
            const copy = SHADOW_STRATEGY_COPY[row.strategy] || {
              name: 'Experimental strategy',
              description: 'A background-only variation under evaluation.',
            }
            return (
            <div key={row.strategy} style={{display:'grid',gridTemplateColumns:'minmax(220px,2fr) repeat(3,minmax(80px,1fr))',gap:10,fontSize:10.5,padding:'9px 0',borderBottom:`1px solid ${C.border}`,alignItems:'center'}}>
              <div>
                <div style={{color:C.text,fontWeight:700}}>{copy.name}</div>
                <div style={{color:C.dim,fontSize:9.5,marginTop:2,lineHeight:1.4}}>{copy.description}</div>
              </div>
              <span style={{color:C.dim}}>{row.assigned} signals tested</span>
              <span style={{color:C.dim}}>{pct(row.winRate)} win rate</span>
              <span style={{color:C.dim}}>{row.expectancyR==null?'No result yet':`${num(row.expectancyR)}R average`}</span>
            </div>
          )})
        }
        <div style={{fontSize:9.5,color:C.dim,marginTop:10,lineHeight:1.5}}>
          Verified forward results, modeled execution estimates, and shadow research remain visually and analytically separate. No strategy is promoted automatically.
        </div>
      </>}
    </div>
  )
}
