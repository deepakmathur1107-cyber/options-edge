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

// ── New for the outcome resolver (Phase 2) ──────────────────────────────────
// Returns an array of 'YYYY-MM-DD' strings for every trading day in
// [startDate, endDate], inclusive, skipping weekends and NYSE holidays.
// Used by the resolver to walk a signal's lifetime one real trading day at a
// time instead of naive calendar-day arithmetic (see resolver spec, §5).
function tradingDaysBetween(startDate, endDate) {
  const start = startDate instanceof Date ? startDate : new Date(startDate + 'T12:00:00')
  const end   = endDate instanceof Date ? endDate : new Date(endDate + 'T12:00:00')
  const days = []
  const cur = new Date(start)
  while (cur <= end) {
    if (isTradingDay(cur)) days.push(ymd(cur))
    cur.setDate(cur.getDate() + 1)
  }
  return days
}

// AUDIT FIX (2026-07-25, Finding 5): NYSE early-close days. Covers the
// three well-known, standard early-close days (1:00 PM ET instead of the
// normal 4:00 PM ET close): the day after Thanksgiving, Christmas Eve, and
// July 3rd, each only when they actually fall on a trading day. HONEST
// LIMITATION: some NYSE early closes are announced ad-hoc (not purely
// rule-based) and aren't captured by a formula — this covers the standard,
// predictable cases, not a complete historical record of every early
// close NYSE has ever announced.
function getEarlyCloseDays(year) {
  const days = new Set()
  const thanksgiving = nthWeekday(year, 11, 4, 4)
  const dayAfterThanksgiving = new Date(thanksgiving)
  dayAfterThanksgiving.setDate(dayAfterThanksgiving.getDate() + 1)
  days.add(ymd(dayAfterThanksgiving))
  const christmasEve = new Date(year, 11, 24)
  if (christmasEve.getDay() !== 0 && christmasEve.getDay() !== 6) days.add(ymd(christmasEve))
  const july3 = new Date(year, 6, 3)
  if (july3.getDay() !== 0 && july3.getDay() !== 6) days.add(ymd(july3))
  return days
}

// getSessionClose(dateStr) — returns the correct Eastern-time market close
// for a trading date: '16:00' normal, '13:00' early close, null if the
// date isn't a trading day at all (weekend/holiday). dateStr: 'YYYY-MM-DD'.
function getSessionClose(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  if (!isTradingDay(d)) return null
  const year = d.getFullYear()
  return getEarlyCloseDays(year).has(dateStr) ? '13:00' : '16:00'
}

module.exports = { isTradingDay, isMarketHours, getHolidays, tzParts, tradingDaysBetween, getEarlyCloseDays, getSessionClose }
