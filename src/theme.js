/**
 * src/theme.js
 * Single source of truth for all theme tokens.
 * Import DARK_THEME, LIGHT_THEME, and getTheme() anywhere.
 */

export const DARK_THEME = {
  // Brand accents
  green:   '#00ff88',
  blue:    '#00c8ff',
  orange:  '#ff9500',
  red:     '#ff4466',

  // Neutrals
  dim:     '#4a7a8a',
  subtext: '#6a9aaa',
  text:    '#c8d8e8',

  // Surfaces
  bg:      '#090e14',
  bgAlt:   '#06090f',
  bgDeep:  '#04080e',
  card:    '#0d1a26',
  cardAlt: '#0b1520',
  panel:   '#070c12',

  // Borders
  border:  '#1a2e3e',
  borderDim: '#0e1e2a',

  // Inputs
  inputBg: '#0d1a26',

  isDark: true,
}

export const LIGHT_THEME = {
  // Brand accents — darkened for readability on white
  green:   '#007a3d',
  blue:    '#0066cc',
  orange:  '#c05800',
  red:     '#cc1133',

  // Neutrals
  dim:     '#5a7a8a',
  subtext: '#4a6070',
  text:    '#1a2e3e',

  // Surfaces
  bg:      '#f4f7fb',
  bgAlt:   '#eef2f7',
  bgDeep:  '#e8edf4',
  card:    '#ffffff',
  cardAlt: '#f0f4f8',
  panel:   '#eaeef4',

  // Borders
  border:  '#cbd5e0',
  borderDim: '#d8e2ec',

  // Inputs
  inputBg: '#ffffff',

  isDark: false,
}

export const getTheme = (isDark) => isDark ? DARK_THEME : LIGHT_THEME
