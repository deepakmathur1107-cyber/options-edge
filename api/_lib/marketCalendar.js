/**
 * api/_lib/marketCalendar.js
 * NYSE holiday calendar + market hours check (CommonJS)
 */

function nthWeekday(year, month, dow, n) {
  const d = new Date(year, month - 1, 1); let count = 0
  while (true) { if (d.getDay() === dow) { count++; if (count === n) return new Date(d) } d.setDate(d.getDate() + 1) }
}
function lastWeekday(year, month, dow) {
  const d = new Date(year, month, 0)
  while (d.getDay() !== dow) d.setDate(d.getDate() - 1)
  return new Date(d)
}
function goodFriday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4
  const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30
  const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451)
  const month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1
  const easter=new Date(year,month-1,day); easter.setDate(easter.getDate()-2); return easter
}
function observed(d) {
  const day=d.getDay()
  if(day===6) return new Date(d.getFullYear(),d.getMonth(),d.getDate()-1)
  if(day===0) return new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)
  return d
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

function getHolidays(year) {
  return new Set([
    ymd(observed(new Date(year,0,1))),
    ymd(nthWeekday(year,1,1,3)),
    ymd(nthWeekday(year,2,1,3)),
    ymd(goodFriday(year)),
    ymd(lastWeekday(year,5,1)),
    ymd(observed(new Date(year,5,19))),
    ymd(observed(new Date(year,6,4))),
    ymd(nthWeekday(year,9,1,1)),
    ymd(nthWeekday(year,11,4,4)),
    ymd(observed(new Date(year,11,25))),
  ])
}

// Get date parts in a timezone safely via Intl
function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  })
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]))
}

function isTradingDay(date) {
  const p = tzParts(date, 'America/New_York')  // NYSE is ET, not CT
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return false
  const key = `${p.year}-${p.month}-${p.day}`
  return !getHolidays(parseInt(p.year, 10)).has(key)
}

// NYSE market hours: 9:30 AM – 4:00 PM ET on trading days
function isMarketHours(date) {
  if (!isTradingDay(date)) return false
  const p    = tzParts(date, 'America/New_York')
  const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10)
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

module.exports = { isTradingDay, isMarketHours, getHolidays, tzParts }
