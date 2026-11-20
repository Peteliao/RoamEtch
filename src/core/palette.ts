// Canvas palettes for poster / track video, following the effective app theme.
import { effectiveTheme } from './theme';

const DARK = {
  panel: '#0b1220',
  text: '#e8eef7',
  muted: '#93a3bd',
  faint: '#5d6f8d',
  accent: '#2dd4a7',
  accentSoft: 'rgba(45,212,167,0.16)',
  accentLine: 'rgba(45,212,167,0.28)',
  amber: '#f5b942',
  vectorBg: '#0e1626',
  grid: 'rgba(36,51,82,0.55)',
  cellBg: 'rgba(147,163,189,0.08)',
  progressTrack: 'rgba(11,18,32,0.65)',
  badgeBg: 'rgba(45,212,167,0.12)',
  badgeEdge: 'rgba(45,212,167,0.65)',
  lut: [[45, 212, 167], [56, 189, 248], [129, 140, 248]],
  wpRing: 'rgba(11,18,32,0.8)',
  endRing: 'rgba(255,255,255,0.92)',
  edgeShade: 'rgba(0,0,0,0.35)'
};

const LIGHT = {
  panel: '#f7f9fc',
  text: '#16233a',
  muted: '#5a6b85',
  faint: '#8b99af',
  accent: '#0d9d78',
  accentSoft: 'rgba(13,157,120,0.14)',
  accentLine: 'rgba(13,157,120,0.30)',
  amber: '#c77800',
  vectorBg: '#eef2f7',
  grid: 'rgba(90,110,140,0.18)',
  cellBg: 'rgba(22,35,58,0.05)',
  progressTrack: 'rgba(22,35,58,0.18)',
  badgeBg: 'rgba(13,157,120,0.10)',
  badgeEdge: 'rgba(13,157,120,0.55)',
  lut: [[13, 157, 120], [2, 132, 199], [79, 70, 229]],
  wpRing: 'rgba(247,249,252,0.9)',
  endRing: 'rgba(22,35,58,0.85)',
  edgeShade: 'rgba(22,35,58,0.18)'
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