import { Link } from 'react-router-dom'

export default function AppNav({ tab, setTab, isDark, setIsDark, C, userInitial, openPortal, onSignOut, tradierMode, autoOn, showTools, setShowTools }) {
  return (
    <div style={{position:'sticky',top:0,zIndex:100,background:C.bg,borderBottom:`1px solid ${C.border}`}}>
      {/* Title row */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'10px 16px 9px'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:8}}>
          <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,letterSpacing:3,color:C.green,lineHeight:1}}>OPTIONS EDGE</span>
          <span style={{fontSize:8,color:C.dim,letterSpacing:2}}>v3.0</span>
        </div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          {autoOn && (
            <span style={{fontSize:9,color:C.green,display:'flex',alignItems:'center',gap:4}}>
              <span style={{width:6,height:6,borderRadius:'50%',background:C.green,display:'inline-block',boxShadow:`0 0 7px ${C.green}`,animation:'pu 1.1s infinite'}}/>
              AUTO
            </span>
          )}
          <span style={{fontSize:9,color:C.dim,letterSpacing:1}}>{tradierMode.toUpperCase()}</span>
          <button onClick={()=>setIsDark(p=>!p)} title={isDark?'Switch to light mode':'Switch to dark mode'} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,borderRadius:4,padding:'5px 9px',fontSize:13,cursor:'pointer',lineHeight:1}}>
            {isDark?'☀':'🌙'}
          </button>
          <button onClick={()=>setShowTools(p=>!p)} style={{background:showTools?`${C.green}18`:'transparent',border:`1px solid ${showTools?C.green:C.border}`,color:showTools?C.green:C.dim,borderRadius:4,padding:'5px 11px',fontSize:11,letterSpacing:.5,cursor:'pointer'}}>
            {showTools ? '✕ CLOSE' : '⚙ TOOLS'}
          </button>
          {userInitial && (
            <div style={{display:'flex',alignItems:'center',gap:6}}>
              <div style={{width:26,height:26,borderRadius:'50%',background:`${C.green}20`,border:`1px solid ${C.green}40`,display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,color:C.green,fontWeight:600}}>
                {(userInitial||'U')[0].toUpperCase()}
              </div>
              <button onClick={openPortal} title="Manage subscription" style={{background:'transparent',border:'none',color:C.dim,fontSize:9,cursor:'pointer',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5,padding:'2px 4px'}}>PRO</button>
              <button onClick={onSignOut} style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,borderRadius:3,padding:'4px 8px',fontSize:9,cursor:'pointer',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5}}>OUT</button>
              <Link to="/app/settings/alerts" style={{background:'transparent',border:`1px solid ${C.border}`,color:C.dim,borderRadius:3,padding:'4px 8px',fontSize:9,textDecoration:'none',fontFamily:"'IBM Plex Mono',monospace",letterSpacing:.5}}>🔔</Link>
            </div>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div style={{display:'flex',borderTop:`1px solid ${C.border}`}}>
        {[
          {id:'dash', icon:'◈', label:'DASH'},
          {id:'scan', icon:'⌁', label:'SCAN'},
        ].map(t=>{
          const active = tab===t.id
          return (
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              display:'flex',alignItems:'center',justifyContent:'center',gap:6,
              padding:'9px 20px',background:'transparent',border:'none',cursor:'pointer',flex:1,
              borderBottom:`2px solid ${active?C.green:'transparent'}`,
              transition:'border-color .2s',
            }}>
              <span style={{fontSize:14,color:active?C.green:C.dim}}>{t.icon}</span>
              <span style={{fontSize:9,letterSpacing:.5,fontFamily:"'IBM Plex Mono',monospace",color:active?C.green:C.dim}}>{t.label}</span>
            </button>
          )
        })}
        <Link to="/app/trades" style={{
          display:'flex',alignItems:'center',justifyContent:'center',gap:6,
          padding:'9px 20px',textDecoration:'none',flex:1,
          borderBottom:'2px solid transparent',
        }}>
          <span style={{fontSize:14,color:C.dim}}>≡</span>
          <span style={{fontSize:9,letterSpacing:.5,fontFamily:"'IBM Plex Mono',monospace",color:C.dim}}>TRADE LOG</span>
        </Link>
      </div>
    </div>
  )
}
