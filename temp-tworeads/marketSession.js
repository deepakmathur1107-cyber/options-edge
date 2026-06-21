// src/lib/marketSession.js
// Shared NYSE trading-session detection — extracted from MorningBrief.jsx so
// the Dashboard's two Read cards (News Read, Price Read) and Market Readout
// all use the exact same pre-market/open/after-hours/closed logic instead of
// each inventing or duplicating their own session check.

// ── NYSE Calendar (weekends + holidays) ──────────────────────────────────────
function nthWD(y,m,dow,n){const d=new Date(y,m-1,1);let c=0;while(true){if(d.getDay()===dow){c++;if(c===n)return new Date(d)}d.setDate(d.getDate()+1)}}
function lastWD(y,m,dow){const d=new Date(y,m,0);while(d.getDay()!==dow)d.setDate(d.getDate()-1);return new Date(d)}
function goodFriday(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;const ea=new Date(y,mo-1,dy);ea.setDate(ea.getDate()-2);return ea}
function obs(d){const w=d.getDay();if(w===6)return new Date(d.getFullYear(),d.getMonth(),d.getDate()-1);if(w===0)return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1);return d}
function ymd(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function holidays(y){return new Set([ymd(obs(new Date(y,0,1))),ymd(nthWD(y,1,1,3)),ymd(nthWD(y,2,1,3)),ymd(goodFriday(y)),ymd(lastWD(y,5,1)),ymd(obs(new Date(y,5,19))),ymd(obs(new Date(y,6,4))),ymd(nthWD(y,9,1,1)),ymd(nthWD(y,11,4,4)),ymd(obs(new Date(y,11,25)))])}
function tzP(date,tz){return Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'numeric',weekday:'short',hour12:false}).formatToParts(date).map(p=>[p.type,p.value]))}
function isTradingDay(d){const p=tzP(d,'America/New_York');if(p.weekday==='Sat'||p.weekday==='Sun')return false;return !holidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)}

// Returns one of: 'pre' | 'open' | 'after' | 'closed'
// Deliberately uses the exact same 9:30 AM / 4:00 PM ET boundaries as
// getMarketStatus() below — two functions computing "is the market open"
// from different boundaries would be a real bug waiting to happen the first
// time they disagreed. 'after' is treated as ending at midnight; anything
// before 9:30 AM that isn't a trading day at all falls back to 'closed'.
export function getSessionPhase(now=new Date()){
  if(!isTradingDay(now)) return 'closed'
  const p = tzP(now,'America/New_York'), mins = parseInt(p.hour,10)*60+parseInt(p.minute,10)
  if(mins<9*60+30) return 'pre'
  if(mins>=16*60)  return 'after'
  return 'open'
}

export function getMarketStatus(now=new Date()){
  if(!isTradingDay(now)){
    const p=tzP(now,'America/Chicago'),isHol=holidays(parseInt(p.year,10)).has(`${p.year}-${p.month}-${p.day}`)
    const nx=new Date(now);for(let i=1;i<=10;i++){nx.setDate(nx.getDate()+1);if(isTradingDay(nx))break}
    return{open:false,reason:isHol?'Market holiday':'Weekend',nextLabel:nx.toLocaleDateString('en-US',{timeZone:'America/Chicago',weekday:'short',month:'short',day:'numeric'})}
  }
  const p=tzP(now,'America/New_York'),mins=parseInt(p.hour,10)*60+parseInt(p.minute,10)
  if(mins<9*60+30)return{open:false,reason:'Pre-market',nextLabel:'today at 9:30 AM ET'}
  if(mins>=16*60) return{open:false,reason:'After hours',nextLabel:'tomorrow 9:30 AM ET'}
  return{open:true,reason:'Market open',nextLabel:null}
}
