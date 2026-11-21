// Canvas palettes for poster / track video, following the effective app theme.
import { effectiveTheme } from './theme';

const DARK = {
  panel: '#000000',
  text: '#ffffff',
  muted: '#b8b8b8',
  faint: '#7a7a7a',
  accent: '#2bcda7',
  accentSoft: 'rgba(43,205,167,0.14)',
  accentLine: 'rgba(43,205,167,0.28)',
  amber: '#f5b942',
  vectorBg: '#000000',
  grid: 'rgba(255,255,255,0.07)',
  cellBg: 'rgba(184,184,184,0.08)',
  progressTrack: 'rgba(255,255,255,0.16)',
  badgeBg: 'rgba(43,205,167,0.12)',
  badgeEdge: 'rgba(43,205,167,0.65)',
  lut: [[16, 143, 116], [37, 99, 235], [109, 40, 217]],
  trackHalo: 'rgba(0,0,0,0.30)',
  trackCasing: 'rgba(0,0,0,0.82)',
  wpRing: 'rgba(0,0,0,0.8)',
  endRing: 'rgba(255,255,255,0.92)',
  edgeShade: 'rgba(0,0,0,0.35)'
};

const LIGHT = {
  panel: '#ffffff',
  text: '#18251f',
  muted: '#728078',
  faint: '#98a49e',
  accent: '#139e7d',
  accentSoft: 'rgba(19,158,125,0.12)',
  accentLine: 'rgba(19,158,125,0.30)',
  amber: '#b45309',
  vectorBg: '#f5f7f6',
  grid: 'rgba(24,37,31,0.08)',
  cellBg: 'rgba(24,37,31,0.05)',
  progressTrack: 'rgba(24,37,31,0.18)',
  badgeBg: 'rgba(19,158,125,0.10)',
  badgeEdge: 'rgba(19,158,125,0.55)',
  lut: [[15, 133, 105], [37, 99, 235], [109, 40, 217]],
  trackHalo: 'rgba(10,30,25,0.28)',
  trackCasing: 'rgba(10,30,25,0.78)',
  wpRing: 'rgba(255,255,255,0.9)',
  endRing: 'rgba(24,37,31,0.85)',
  edgeShade: 'rgba(24,37,31,0.18)'
};

// "Sunlight contrast" is a light, high-contrast theme: white surface, pure
// black text, deep-green accent — matches :root[data-theme="contrast"] in CSS.
const CONTRAST = {
  panel: '#ffffff',
  text: '#000000',
  muted: '#1a1a1a',
  faint: '#333333',
  accent: '#00694f',
  accentSoft: 'rgba(0,105,79,0.16)',
  accentLine: 'rgba(0,105,79,0.42)',
  amber: '#8a5b00',
  vectorBg: '#ffffff',
  grid: 'rgba(0,0,0,0.30)',
  cellBg: 'rgba(0,0,0,0.06)',
  progressTrack: 'rgba(0,0,0,0.20)',
  badgeBg: 'rgba(0,105,79,0.12)',
  badgeEdge: '#00694f',
  lut: [[0, 105, 79], [0, 68, 170], [140, 0, 140]],
  trackHalo: 'rgba(0,0,0,0.35)',
  trackCasing: 'rgba(0,0,0,0.88)',
  wpRing: 'rgba(255,255,255,0.95)',
  endRing: '#000000',
  edgeShade: 'rgba(0,0,0,0.25)'
};

export function paletteFor(theme: string) {
  return theme === 'light' ? LIGHT : theme === 'contrast' ? CONTRAST : DARK;
}

export function canvasPalette() {
  return paletteFor(effectiveTheme());
}