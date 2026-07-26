import { useState } from 'react'

const pct = value => value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`
const num = value => value == null ? '—' : Number(value).toFixed(2)

export default function ForwardPerformancePanel({ getToken, theme: C }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = async () => {
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
  }

  const cards = data ? [
    ['Enrolled', data.enrolled],
    ['Measured', data.resolvedWithExecutionMetrics],
    ['Expectancy', data.promotion.metrics.expectancyR == null ? '—' : `${num(data.promotion.metrics.expectancyR)}R`],
    ['Profit factor', num(data.promotion.metrics.profitFactor)],
    ['Win rate', pct(data.promotion.metrics.winRate)],
    ['Cohorts', data.promotion.metrics.cohorts],
  ] : []

  return (
    <div>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12,gap:10}}>
        <div style={{fontSize:11,color:C.dim,lineHeight:1.5}}>
          Forward-only, execution-adjusted Qualified V1 evidence. Promotion cannot occur unless every gate passes.
        </div>
        <button onClick={load} disabled={loading} style={{background:`${C.blue}18`,border:`1px solid ${C.blue}45`,color:C.blue,padding:'5px 12px',borderRadius:4,cursor:'pointer'}}>
          {loading ? 'LOADING…' : 'LOAD'}
        </button>
      </div>
      {error && <div style={{color:C.red,fontSize:11,marginBottom:10}}>{error}</div>}
      {!data && !loading && <div style={{color:C.dim,fontSize:12,padding:'12px 0'}}>Load the latest forward cohort.</div>}
      {data && <>
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
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(190px,1fr))',gap:6,marginBottom:12}}>
          {Object.entries(data.promotion.checks).map(([gate,passed]) => (
            <div key={gate} style={{fontSize:11,color:passed?C.green:C.dim}}>
              {passed?'✓':'○'} {gate.replaceAll(/([A-Z])/g,' $1')}
            </div>
          ))}
        </div>
        <div style={{fontSize:10,color:C.dim,marginBottom:5}}>SHADOW STRATEGIES</div>
        {(data.shadowStrategies||[]).length === 0
          ? <div style={{fontSize:11,color:C.dim}}>Waiting for live shadow assignments.</div>
          : data.shadowStrategies.map(row => (
            <div key={row.strategy} style={{display:'grid',gridTemplateColumns:'2fr repeat(3,1fr)',gap:8,fontSize:10.5,padding:'5px 0',borderBottom:`1px solid ${C.border}`}}>
              <span style={{color:C.text}}>{row.strategy}</span>
              <span style={{color:C.dim}}>{row.assigned} assigned</span>
              <span style={{color:C.dim}}>{pct(row.winRate)} win</span>
              <span style={{color:C.dim}}>{row.expectancyR==null?'—':`${num(row.expectancyR)}R`}</span>
            </div>
          ))
        }
      </>}
    </div>
  )
}
