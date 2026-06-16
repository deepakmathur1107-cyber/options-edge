import { useState, useEffect } from 'react'
import { useAuth, useUser, SignOutButton } from '@clerk/clerk-react'

const F  = 'IBM Plex Mono, monospace'
const BB = 'Bebas Neue, Georgia, serif'

export default function Paywall() {
  const { getToken }  = useAuth()
  const { user }      = useUser()
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState('')
  const [trialEligible, setTrialEligible] = useState(null) // null = checking

  // On mount, ask the backend if this user still qualifies for a trial
  useEffect(() => {
    const check = async () => {
      try {
        const token = await getToken()
        const res   = await fetch('/api/stripe/trial-status', {
          headers: { Authorization: `Bearer ${token}` },
        })
        const data = await res.json()
        setTrialEligible(data.eligible)
      } catch {
        setTrialEligible(false) // safe default — no trial if check fails
      }
    }
    check()
  }, [getToken])

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

  // Derived display values based on trial eligibility
  const checking        = trialEligible === null
  const hasTrial        = trialEligible === true
  const priceLine       = hasTrial
    ? <><span style={{ fontFamily:BB, fontSize:40, color:'#c8d8e8', letterSpacing:1 }}>$19</span><span style={{ fontSize:16, color:'#4a7a8a' }}>/month</span></>
    : <><span style={{ fontFamily:BB, fontSize:40, color:'#c8d8e8', letterSpacing:1 }}>$19</span><span style={{ fontSize:16, color:'#4a7a8a' }}>/month</span></>
  const trialBadge      = hasTrial
    ? <div style={{ fontSize:10, color:'#00ff88', marginTop:4, letterSpacing:1 }}>7-DAY FREE TRIAL INCLUDED</div>
    : <div style={{ fontSize:10, color:'#ff8844', marginTop:4, letterSpacing:1 }}>FREE TRIAL ALREADY USED — BILLED IMMEDIATELY</div>
  const ctaLabel        = loading
    ? 'REDIRECTING TO CHECKOUT...'
    : hasTrial
      ? 'START 7-DAY FREE TRIAL →'
      : 'SUBSCRIBE NOW — $19/MONTH →'
  const fineprint       = hasTrial
    ? 'No charge during trial · Cancel anytime · Secure payment via Stripe'
    : 'Your card will be charged $19 today · Cancel anytime · Secure payment via Stripe'
  const subheadline     = hasTrial
    ? <>Hi {user?.firstName||'there'}. Your free trial has ended or you don't have an active subscription.<br/>Subscribe to continue using Options Edge.</>
    : <>Hi {user?.firstName||'there'}. You've already used your free trial.<br/>Subscribe at $19/month to regain full access — billed immediately, cancel anytime.</>

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
          {checking ? 'Checking your account...' : subheadline}
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
          <div>{priceLine}</div>
          {!checking && trialBadge}
        </div>

        {/* Trial-used warning banner */}
        {!checking && !hasTrial && (
          <div style={{ background:'#1a0e04', border:'1px solid #ff884440', borderRadius:4, padding:'10px 14px', fontSize:11, color:'#ffaa66', marginBottom:14, lineHeight:1.7 }}>
            ⚠️ Your 7-day free trial has already been used on this account. Subscribing now will charge your card immediately.
          </div>
        )}

        {error && (
          <div style={{ background:'#1a0408', border:'1px solid #ff446640', borderRadius:4, padding:'9px 12px', fontSize:11, color:'#ff8090', marginBottom:14, lineHeight:1.6 }}>{error}</div>
        )}

        <button
          className="hv"
          onClick={startCheckout}
          disabled={loading || checking}
          style={{
            width:'100%', padding:'14px', borderRadius:5, fontSize:14,
            cursor:(loading||checking)?'default':'pointer',
            fontFamily:BB, letterSpacing:2, marginBottom:12,
            background: (loading||checking)?'#00ff8810':'#00ff8822',
            border:`1px solid ${(loading||checking)?'#1a2e3e':'#00ff88'}`,
            color: (loading||checking)?'#2a6050':'#00ff88',
          }}
        >
          {checking ? 'CHECKING ACCOUNT...' : ctaLabel}
        </button>

        <div style={{ fontSize:10, color:'#2a4a5a', lineHeight:1.8 }}>
          {checking ? '' : fineprint}
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
