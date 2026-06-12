/**
 * src/theme.js
 * Single source of truth for all theme tokens.
 * Import DARK_THEME, LIGHT_THEME, and getTheme() anywhere.
 *
 * Color philosophy:
 *   green  = bullish / gain / positive signal
 *   red    = bearish / loss / risk / stop
 *   orange = neutral / caution / sideways
 *   blue   = informational / levels / data / links
 *   purple = premium / unusual activity / high conviction
 *   cyan   = secondary data / labels / scanner metadata
 */

export const DARK_THEME = {
  // Semantic accents — desaturated for extended use, still clearly directional
  green:   '#00c85a',   // bullish / gain
  red:     '#ef4444',   // bearish / loss / risk
  orange:  '#f59e0b',   // neutral / caution
  blue:    '#3b82f6',   // info / levels / links
  purple:  '#a855f7',   // premium / unusual / high conviction
  cyan:    '#06b6d4',   // scanner metadata / secondary data

  // Neutrals — readable at distance, comfortable for long sessions
  dim:     '#64748b',   // muted labels, placeholders
  subtext: '#94a3b8',   // secondary text
  text:    '#e2e8f0',   // primary body text

  // Surfaces — midnight blue, not pure black
  bg:      '#0a0f1a',   // page background
  bgAlt:   '#080d16',   // deeper background
  bgDeep:  '#060a12',   // deepest / nav
  card:    '#0f1923',   // card surface
  cardAlt: '#162030',   // card header / alternate surface
  panel:   '#0d1620',   // panel / drawer

  // Borders
  border:    '#1e2d3d',
  borderDim: '#162030',

  // Inputs
  inputBg: '#0f1923',

  isDark: true,

  shadow:   '0 1px 3px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.4)',
  shadowMd: '0 4px 16px rgba(0,0,0,.6), 0 2px 6px rgba(0,0,0,.4)',
  shadowLg: '0 10px 32px rgba(0,0,0,.7), 0 4px 10px rgba(0,0,0,.5)',
  radius:   '10px',
  radiusSm: '6px',
}

export const LIGHT_THEME = {
  // Semantic accents — dark enough to read on white, still clearly directional
  green:   '#166534',   // bullish / gain
  red:     '#991b1b',   // bearish / loss / risk
  orange:  '#92400e',   // neutral / caution
  blue:    '#1d4ed8',   // info / levels / links
  purple:  '#7c3aed',   // premium / unusual / high conviction
  cyan:    '#0e7490',   // scanner metadata / secondary data

  // Neutrals
  dim:     '#64748b',
  subtext: '#475569',
  text:    '#0f172a',

  // Surfaces — clean slate, no warm tinting
  bg:      '#f1f5f9',
  bgAlt:   '#e8edf4',
  bgDeep:  '#dde4ee',
  card:    '#ffffff',
  cardAlt: '#f8fafc',
  panel:   '#f0f4f8',

  // Borders
  border:    '#e2e8f0',
  borderDim: '#cbd5e1',

  // Inputs
  inputBg: '#ffffff',

  isDark: false,

  shadow:   '0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.05)',
  shadowMd: '0 4px 12px rgba(0,0,0,.10), 0 2px 4px rgba(0,0,0,.06)',
  shadowLg: '0 10px 24px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.07)',
  radius:   '10px',
  radiusSm: '6px',
}

export const getTheme = (isDark) => isDark ? DARK_THEME : LIGHT_THEME
