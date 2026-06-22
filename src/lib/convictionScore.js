// src/lib/convictionScore.js
// Thin ESM re-export of the canonical CommonJS scoring module in
// api/_lib/convictionScore.cjs. Vite's ESM bundler can't directly `import`
// a CommonJS module without an export statement to latch onto — but it CAN
// resolve and bundle a .cjs file referenced from an ESM file like this one.
// Verified with a build test before relying on it: a real `vite build` with
// this exact wrapper pattern wired into the actual entry point correctly
// bundled the .cjs file (module count increased as expected) and the
// function call resolved and executed correctly in the output bundle.
//
// Do not duplicate the scoring logic here — this file should never contain
// any `score +=` / `score -=` lines itself. If it does, the consolidation
// this file exists for has failed.
//
// pickBetterSide added alongside scoreConviction: needed by the client-side
// two-sided scoring change in App.jsx (runScan/scanOneTicker now score both
// call and put against the real chain and choose the higher side, same as
// the server-side cron — see convictionScore.cjs's pickBetterSide comment
// for why the comparison logic lives there and not duplicated here).
import convictionModule from '../../api/_lib/convictionScore.cjs'
export const scoreConviction = convictionModule.scoreConviction
export const pickBetterSide = convictionModule.pickBetterSide
