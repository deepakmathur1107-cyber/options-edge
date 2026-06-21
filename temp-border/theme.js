/**
 * src/theme.js
 * Single source of truth for all theme tokens.
 * Import DARK_THEME, LIGHT_THEME, and getTheme() anywhere.
 *
 * "Signal" palette — approved direction, replacing the prior midnight-blue
 * / neon green-red theme. Dark theme is warm slate with an amber accent;
 * up/down uses sage/clay instead of neon green/red for a calmer, less
 * alarm-coded feel. Light theme uses conventional red/blue instead (the
 * "Light B" variant), since sage/clay read as too washed-out on a bright
 * background and the calm-vs-conventional tradeoff was decided in favor
 * of readability for light mode specifically.
 *
 * Color philosophy:
 *   green  = bullish / gain / positive signal   (sage in dark, red/blue-system red in light is NOT used here — see red below)
 *   red    = bearish / loss / risk / stop
 *   orange = neutral / caution / sideways        (also doubles as the amber brand accent in dark mode)
 *   blue   = informational / levels / data / links
 *   purple = premium / unusual activity / high conviction
 *   cyan   = secondary data / labels / scanner metadata
 */

export const DARK_THEME = {
  // Semantic accents
  green:   '#8aab7e',   // sage — bullish / gain (replaces neon green)
  red:     '#c57762',   // FIX: was #c2705a at 4.39:1 on card bg — just under AA
  orange:  '#e8a84e',   // amber — neutral / caution, and primary brand accent
  blue:    '#7ba3c2',   // info / levels / links
  purple:  '#b08bc4',   // premium / unusual / high conviction — warm-shifted to sit with the rest of the palette
  cyan:    '#7bb3b8',   // scanner metadata / secondary data — warm-shifted teal

  // Neutrals — warm slate instead of cool slate
  dim:     '#938a7e',   // FIX: was #8a8073 at 4.12:1 on card bg — just under AA
  subtext: '#b8ad9c',   // secondary text
  text:    '#f0ebe2',   // primary body text

  // Surfaces — warm dark slate, not midnight blue
  bg:      '#1c1916',   // page background
  bgAlt:   '#19160f',   // deeper background
  bgDeep:  '#15120f',   // deepest / nav
  card:    '#25211c',   // card surface
  cardAlt: '#2c2722',   // card header / alternate surface
  panel:   '#211d18',   // panel / drawer

  // Borders
  border:    '#3a342c',
  borderDim: '#2c2722',

  // Inputs
  inputBg: '#15120f',

  isDark: true,

  shadow:   '0 1px 3px rgba(0,0,0,.4), 0 1px 2px rgba(0,0,0,.3)',
  shadowMd: '0 4px 18px rgba(0,0,0,.45), 0 2px 6px rgba(0,0,0,.3)',
  shadowLg: '0 10px 32px rgba(0,0,0,.55), 0 4px 10px rgba(0,0,0,.4)',
  radius:   '12px',
  radiusSm: '7px',
}

export const LIGHT_THEME = {
  // Semantic accents — true red/blue (Light B), not the sage/clay dark-mode language
  green:   '#1f7a3d',   // bullish / gain
  red:     '#c0392b',   // bearish / loss / risk
  orange:  '#9d6423',   // FIX: was #b9762a at 3.43-3.69:1 — failed AA. This is the
                         // exact color behind "MARKET CLOSED", the disagree-note,
                         // and "Neutral" — directly what looked hard to read.
  blue:    '#1d5fa8',   // info / levels / links
  purple:  '#835aa7',   // FIX: was #8a5fb0 at 4.49:1 — just under AA threshold
  cyan:    '#31757c',   // FIX: was #3a8a93 at 3.72-4.01:1 — failed AA

  // Neutrals — warm cream, not cool gray
  dim:     '#766a52',   // FIX: was #9a8f7c at 2.96:1 contrast on bg — failed WCAG AA
                         // for normal text (140+ usages across the app, mostly small
                         // uppercase labels — exactly where low contrast hurts most).
                         // This clears 4.93:1 while staying lighter than subtext.
  subtext: '#6b6152',
  text:    '#2a2520',

  // Surfaces — warm cream/parchment instead of cool slate-white
  bg:      '#faf6ef',
  bgAlt:   '#f6f0e3',
  bgDeep:  '#f3ecdf',
  card:    '#ffffff',
  cardAlt: '#f8f3ea',
  panel:   '#f6f0e3',

  // Borders
  // FIX: was #e6dcc8 — only 1.36:1 contrast against white cards, 1.08:1
  // card-vs-page-bg. Cards with a colored/tinted accent border (e.g. Price
  // Read when data exists) masked this; plain cards with no such accent
  // (Scan's inactive timeframe pills) read as flat/dull because the border
  // alone wasn't doing enough work. Darkened to ~2.45:1 against both.
  border:    '#aca596',
  borderDim: '#dccdb4',

  // Inputs
  inputBg: '#ffffff',

  isDark: false,

  // FIX: shadow opacity bumped slightly (.06→.09, .04→.06) for the same
  // reason as border above — was too faint to read as real surface
  // separation on cards without a colored accent doing extra work.
  shadow:   '0 1px 3px rgba(0,0,0,.09), 0 1px 2px rgba(0,0,0,.06)',
  shadowMd: '0 4px 14px rgba(0,0,0,.11), 0 2px 4px rgba(0,0,0,.07)',
  shadowLg: '0 10px 24px rgba(0,0,0,.13), 0 4px 8px rgba(0,0,0,.08)',
  radius:   '12px',
  radiusSm: '7px',
}

export const getTheme = (isDark) => isDark ? DARK_THEME : LIGHT_THEME
