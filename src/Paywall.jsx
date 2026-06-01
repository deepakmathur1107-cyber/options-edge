import { useState } from 'react'
import { useAuth, useUser, SignOutButton } from '@clerk/clerk-react'

const F  = 'IBM Plex Mono, monospace'
const BB = 'Bebas Neue, Georgia, serif'

export default function Paywall() {
  const { getToken }  = useAuth()
  const { user }      = useUser()
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const startCheckout = async () => {
    setLoading(true); setError('')
    try {
      const token = await getToken()
      const res   = await fetch('/api/stripe/checkout', {
        method:  'POST',
        headers: { 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body:    JSON.stringify({ email: user?.primaryEmailAddress?.emailAddress }),
      })
      const data = await res.json()
      if (data.url) {
        window.location.href = data.url
      } else {
        setError(data.error || 'Could not start checkout. Please try again.')
      }
    } catch (e) {
      setError(e.message)
    }
    setLoading(false)
  }

  return (
    <div style={{ background:'#090e14', minHeight:'100vh', fontFamily:F, color:'#c8d8e8', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'24px' }}>
      <style>{`*{box-sizing:border-box;margin:0;padding:0}.hv{cursor:pointer;transition:opacity.15s}.hv:hover{opacity:.8}`}</style>

      {/* Header */}
      <div style={{ position:'fixed', top:0, left:0, right:0, padding:'12px 20px', background:'#090e14', borderBottom:'1px solid #1a2e3e', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div style={{ fontFamily:BB, fontSize:18, letterSpacing:3, color:'#00ff88' }}>OPTIONS EDGE</div>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ fontSize:11, color:'#4a7a8a' }}>{user?.primaryEmailAddress?.emailAddress}</span>
          <SignOutButton>
            <button className="hv" style={{ background:'transparent', border:'1px solid #1a2e3e', color:'#4a7a8a', padding:'5px 12px', borderRadius:3, fontSize:10, cursor:'pointer', fontFamily:F }}>SIGN OUT</button>
          </SignOutButton>
        </div>
      </div>

      {/* Card */}
      <div style={{ maxWidth:480, width:'100%', background:'#0d1a26', border:'1px solid #1a2e3e', borderRadius:8, padding:'36px 32px', textAlign:'center', marginTop:60 }}>
        <div style={{ fontSize:32, marginBottom:16 }}>🔒</div>
        <div style={{ fontFamily:BB, fontSize:26, color:'#c8d8e8', letterSpacing:3, marginBottom:8 }}>PRO ACCESS REQUIRED</div>
        <div style={{ fontSize:12, color:'#4a7a8a', lineHeight:1.8, marginBottom:28 }}>
          Hi {user?.firstName||'there'}. Your free trial has ended or you don't have an active subscription.<br/>
          Subscribe to continue using Options Edge.
        </div>

        {/* What's included */}
        <div style={{ background:'#04080e', border:'1px solid #1a2e3e', borderRadius:6, padding:'16px', marginBottom:24, textAlign:'left' }}>
          {[
            'Unlimited GEX-weighted scans',
            'Auto-scanner across full S&P 500',
            'SPX / NDX index alerts',
            'Email + Telegram trade alerts',
            'Morning AI market readout',
            'Unlimited journal + backtest',
            '6 hard-block filters (skip losing trades)',
          ].map((f,i)=>(
            <div key={i} style={{ fontSize:11, color:'#8ab0c0', padding:'4px 0', display:'flex', gap:8 }}>
              <span style={{ color:'#00ff88', flexShrink:0 }}>✓</span>{f}
            </div>
          ))}
        </div>

        {/* Pricing */}
        <div style={{ marginBottom:20 }}>
          <div style={{ fontFamily:BB, fontSize:40, color:'#c8d8e8', letterSpacing:1 }}>$29<span style={{ fontSize:16, color:'#4a7a8a' }}>/month</span></div>
          <div style={{ fontSize:10, color:'#00ff88', marginTop:4, letterSpacing:1 }}>7-DAY FREE TRIAL INCLUDED</div>
        </div>

        {error && (
          <div style={{ background:'#1a0408', border:'1px solid #ff446640', borderRadius:4, padding:'9px 12px', fontSize:11, color:'#ff8090', marginBottom:14, lineHeight:1.6 }}>{error}</div>
        )}

        <button className="hv" onClick={startCheckout} disabled={loading} style={{
          width:'100%', padding:'14px', borderRadius:5, fontSize:14, cursor:loading?'default':'pointer',
          fontFamily:BB, letterSpacing:2, marginBottom:12,
          background: loading?'#00ff8810':'#00ff8822',
          border:`1px solid ${loading?'#1a2e3e':'#00ff88'}`,
          color: loading?'#2a6050':'#00ff88',
        }}>
          {loading ? 'REDIRECTING TO CHECKOUT...' : 'START 7-DAY FREE TRIAL →'}
        </button>

        <div style={{ fontSize:10, color:'#2a4a5a', lineHeight:1.8 }}>
          No charge during trial · Cancel anytime · Secure payment via Stripe
        </div>
      </div>

      {/* Manage existing sub */}
      <div style={{ marginTop:20, fontSize:11, color:'#2a4a5a' }}>
        Already subscribed? <button className="hv" onClick={async()=>{
          const token=await getToken()
          const res=await fetch('/api/stripe/portal',{method:'POST',headers:{Authorization:`Bearer ${token}`}})
          const d=await res.json()
          if(d.url) window.location.href=d.url
        }} style={{ background:'none', border:'none', color:'#4a7a8a', cursor:'pointer', fontFamily:F, fontSize:11, textDecoration:'underline' }}>Manage subscription</button>
      </div>
    </div>
  )
}
