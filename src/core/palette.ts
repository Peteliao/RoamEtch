// Canvas palettes for poster / track video, following the effective app theme.
import { effectiveTheme } from './theme';

const DARK = {
  panel: '#101820',
  text: '#f2f5f7',
  muted: '#93a1ac',
  faint: '#6f7e89',
  accent: '#2bcda7',
  accentSoft: 'rgba(43,205,167,0.14)',
  accentLine: 'rgba(43,205,167,0.28)',
  amber: '#f5b942',
  vectorBg: '#101820',
  grid: 'rgba(255,255,255,0.06)',
  cellBg: 'rgba(147,161,172,0.08)',
  progressTrack: 'rgba(16,24,32,0.65)',
  badgeBg: 'rgba(43,205,167,0.12)',
  badgeEdge: 'rgba(43,205,167,0.65)',
  lut: [[43, 205, 167], [56, 189, 248], [129, 140, 248]],
  wpRing: 'rgba(16,24,32,0.8)',
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
  lut: [[19, 158, 125], [37, 99, 235], [124, 58, 237]],
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
  wpRing: 'rgba(255,255,255,0.95)',
  endRing: '#000000',
  edgeShade: 'rgba(0,0,0,0.25)'
};

export function canvasPalette() {
  const th = effectiveTheme();
  return th === 'light' ? LIGHT : th === 'contrast' ? CONTRAST : DARK;
}