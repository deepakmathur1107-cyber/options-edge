# Options Edge v3.0
### Real-time S&P 500 Options Scanner with Telegram Auto-Alerts

---

## Deploy to Vercel in 5 Minutes

### Step 1 — GitHub
1. Go to **github.com** → New repository → name it `options-edge` → Create
2. Upload this entire folder (drag & drop all files)
3. Commit

### Step 2 — Vercel
1. Go to **vercel.com** → Sign up with GitHub (free)
2. Click **Add New Project** → Import your `options-edge` repo
3. Click **Deploy** (Vercel auto-detects Vite)

### Step 3 — Add Environment Variables (optional but recommended)
In Vercel → Project → Settings → Environment Variables:

| Name | Value |
|------|-------|
| `TRADIER_TOKEN` | Your Tradier Bearer token |
| `TRADIER_MODE` | `production` or `sandbox` |
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your channel ID |

> If you set env vars here, tokens are stored securely on the server.
> You can also enter them directly in the app's ⚙️ Settings tab.

### Step 4 — Done!
Your app is live at `https://options-edge-xxxx.vercel.app`

---

## How It Works

### Real Tradier Data Flow
```
Browser → /api/tradier (Vercel serverless) → api.tradier.com
```
No CORS issues because the API call happens server-side on Vercel.

### Telegram Auto-Send Flow
```
Auto-scanner finds 80%+ conviction trade
→ /api/telegram (Vercel serverless) → api.telegram.org → your channel
```

### What gets fetched per scan
1. **Live stock quote** — price, change %, volume, 52w high/low
2. **Real expiry dates** — actual options expiration calendar
3. **Live options chain** — bid, ask, IV, delta, theta, volume, OI
4. **Best strike** — calculated from real price, 2% OTM

---

## Getting Your Tradier Token
1. Sign up free at **tradier.com**
2. Dashboard → API Access → copy Bearer Token
3. **Production** = real data (free = 15-min delayed, $10/mo = real-time)
4. **Sandbox** = simulated test data only

## Getting Your Telegram Bot
1. Open Telegram → search **@BotFather**
2. Send `/newbot` → follow steps → copy **Bot Token**
3. Add bot to your channel as **admin**
4. Get Chat ID: visit `https://api.telegram.org/bot{TOKEN}/getUpdates`

---

## Auto-Scanner
- Scans your watchlist (or full SP500 pool if blank) every 5 minutes
- Scores each ticker: volume ratio, IV level, delta, price change, strike activity
- When conviction hits your threshold (default 80%) → auto-posts to Telegram
- All data comes from live Tradier API

---

## Local Development
```bash
npm install
npm run dev
# Open http://localhost:3000
```
