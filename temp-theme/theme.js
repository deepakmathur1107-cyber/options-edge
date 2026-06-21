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
  red:     '#c2705a',   // clay — bearish / loss / risk (replaces neon red)
  orange:  '#e8a84e',   // amber — neutral / caution, and primary brand accent
  blue:    '#7ba3c2',   // info / levels / links
  purple:  '#b08bc4',   // premium / unusual / high conviction — warm-shifted to sit with the rest of the palette
  cyan:    '#7bb3b8',   // scanner metadata / secondary data — warm-shifted teal

  // Neutrals — warm slate instead of cool slate
  dim:     '#8a8073',   // muted labels, placeholders
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
  orange:  '#b9762a',   // neutral / caution / accent
  blue:    '#1d5fa8',   // info / levels / links
  purple:  '#8a5fb0',   // premium / unusual / high conviction
  cyan:    '#3a8a93',   // scanner metadata / secondary data

  // Neutrals — warm cream, not cool gray
  dim:     '#9a8f7c',
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
  border:    '#e6dcc8',
  borderDim: '#efe7d8',

  // Inputs
  inputBg: '#ffffff',

  isDark: false,

  shadow:   '0 1px 3px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.04)',
  shadowMd: '0 4px 14px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.05)',
  shadowLg: '0 10px 24px rgba(0,0,0,.10), 0 4px 8px rgba(0,0,0,.06)',
  radius:   '12px',
  radiusSm: '7px',
}

export const getTheme = (isDark) => isDark ? DARK_THEME : LIGHT_THEME
