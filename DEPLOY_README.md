# diag-400-investigation-v2

Follow-up on the 400-rate investigation. The first diagnostic (already
deployed, confirmed via deployment_sha in resolver_runs) is genuinely
running - verified via direct code read, correct deployment SHA, correct
placement, no earlier call site. Despite that, the log line never
appeared in any search, even the most specific possible ("occSymbol").

## What changed
Narrowed from logging every failure (~40/run) to logging only the FIRST
failure per invocation - in case 40 warn-lines in one request was hitting
a Vercel log-volume limit or sampling behavior.

## A real bug caught in my own first attempt at this fix
Initially used a global.__diag400Logged flag to achieve "log once per
run." Caught before shipping: in a serverless environment, a warm
(reused) function instance can carry global state across invocations -
meaning after the FIRST run ever logged once, every subsequent run on
that same warm instance would silently skip logging forever, with no
error, no obvious sign anything was wrong. Fixed by using rateTracker
instead, which is confirmed freshly created (newRateTracker()) at the
top of the handler on every single invocation - genuinely per-request
scoped, not shared.

## Verified before packaging
- Syntax clean.
- Full test suite: 40/40 passing.
- Confirmed rateTracker is created fresh per invocation (grep + read),
  not reused across warm instances.

## Deploy (Git Bash)
    cd /c/Users/deepa/options-edge
    unzip -o /c/Users/deepa/Downloads/diag-400-investigation-v2.zip -d /c/Users/deepa/options-edge
    git add api/cron/resolve-outcomes.js
    git commit -m "diag: narrow 400-investigation logging to first failure per run, fix unsafe global-state flag"
    git push origin main
    npx vercel --prod --force

## After deploy
Given today's deployment-propagation delay, please wait a few minutes
after deploying before triggering, and I'll check resolver_runs'
deployment_sha directly to confirm the new code is actually live before
triggering and checking logs - not assuming "READY" means "live" this
time.
