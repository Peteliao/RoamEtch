// Single source of truth for selectable themes and every exported appearance.
// Keep this module free of settings/store/browser state so it is safe to import
// from CSS bootstrap, tests, canvas exporters and the offline HTML generator.
export type ConcreteThemeId = 'dark' | 'light' | 'contrast' | 'matrix' | 'neon' | 'starship' | 'aurora' | 'amber' | 'deepsea' | 'vermilion';
export type ThemeMode = 'auto' | ConcreteThemeId;
export type ThemeEffect = ConcreteThemeId;

export interface CanvasPalette {
  panel: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  accentLine: string;
  amber: string;
  vectorBg: string;
  grid: string;
  cellBg: string;
  progressTrack: string;
  badgeBg: string;
  badgeEdge: string;
  lut: [number, number, number][];
  trackHalo: string;
  trackCasing: string;
  wpRing: string;
  endRing: string;
  edgeShade: string;
}

export interface ThemeLabels { zh: string; en: string }
export interface ThemeOption { id: ThemeMode; labelKey: string; auto?: true }
export interface ThemeDefinition {
  id: ConcreteThemeId;
  labelKey: string;
  labels: ThemeLabels;
  colorScheme: 'light' | 'dark';
  effect: ThemeEffect;
  palette: CanvasPalette;
  ui: {
    bgElev: string; bgCard: string; bgInput: string;
    border: string; borderStrong: string; accentStrong: string; accentInk: string;
    danger: string; info: string; trackCasing: string; trackGap: string;
    shadow1: string; shadow2: string; glass: string;
    radiusLg?: string; radius?: string; radiusSm?: string; fontNum?: string;
    mapAttrib: string; mapIconFilter: string; mapControlFilter: string;
  };
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'auto', labelKey: 'settings.themeAuto', auto: true },
  { id: 'dark', labelKey: 'settings.themeDark' },
  { id: 'light', labelKey: 'settings.themeLight' },
  { id: 'contrast', labelKey: 'settings.themeContrast' },
  { id: 'matrix', labelKey: 'settings.themeMatrix' },
  { id: 'neon', labelKey: 'settings.themeNeon' },
  { id: 'starship', labelKey: 'settings.themeStarship' },
  { id: 'aurora', labelKey: 'settings.themeAurora' },
  { id: 'amber', labelKey: 'settings.themeAmber' },
  { id: 'deepsea', labelKey: 'settings.themeDeepsea' },
  { id: 'vermilion', labelKey: 'settings.themeVermilion' }
];

export const CONCRETE_THEME_IDS = THEME_OPTIONS.filter((o) => !o.auto).map((o) => o.id) as ConcreteThemeId[];
export const HTML_THEME_CYCLE = [...CONCRETE_THEME_IDS];

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_OPTIONS.some((o) => o.id === value);
}
export function isConcreteTheme(value: unknown): value is ConcreteThemeId {
  return typeof value === 'string' && CONCRETE_THEME_IDS.includes(value as ConcreteThemeId);
}

const DARK: CanvasPalette = {
  panel: '#000000', text: '#ffffff', muted: '#b8b8b8', faint: '#7a7a7a',
  accent: '#2bcda7', accentSoft: 'rgba(43,205,167,0.14)', accentLine: 'rgba(43,205,167,0.28)', amber: '#f5b942',
  vectorBg: '#000000', grid: 'rgba(255,255,255,0.07)', cellBg: 'rgba(184,184,184,0.08)',
  progressTrack: 'rgba(255,255,255,0.16)', badgeBg: 'rgba(43,205,167,0.12)', badgeEdge: 'rgba(43,205,167,0.65)',
  lut: [[16, 143, 116], [37, 99, 235], [109, 40, 217]],
  trackHalo: 'rgba(0,0,0,0.30)', trackCasing: 'rgba(0,0,0,0.82)', wpRing: 'rgba(0,0,0,0.8)',
  endRing: 'rgba(255,255,255,0.92)', edgeShade: 'rgba(0,0,0,0.35)'
};
const LIGHT: CanvasPalette = {
  panel: '#ffffff', text: '#18251f', muted: '#728078', faint: '#98a49e',
  accent: '#139e7d', accentSoft: 'rgba(19,158,125,0.12)', accentLine: 'rgba(19,158,125,0.30)', amber: '#b45309',
  vectorBg: '#f5f7f6', grid: 'rgba(24,37,31,0.08)', cellBg: 'rgba(24,37,31,0.05)',
  progressTrack: 'rgba(24,37,31,0.18)', badgeBg: 'rgba(19,158,125,0.10)', badgeEdge: 'rgba(19,158,125,0.55)',
  lut: [[15, 133, 105], [37, 99, 235], [109, 40, 217]],
  trackHalo: 'rgba(10,30,25,0.28)', trackCasing: 'rgba(10,30,25,0.78)', wpRing: 'rgba(255,255,255,0.9)',
  endRing: 'rgba(24,37,31,0.85)', edgeShade: 'rgba(24,37,31,0.18)'
};
const CONTRAST: CanvasPalette = {
  panel: '#ffffff', text: '#000000', muted: '#1a1a1a', faint: '#333333',
  accent: '#00694f', accentSoft: 'rgba(0,105,79,0.16)', accentLine: 'rgba(0,105,79,0.42)', amber: '#8a5b00',
  vectorBg: '#ffffff', grid: 'rgba(0,0,0,0.30)', cellBg: 'rgba(0,0,0,0.06)',
  progressTrack: 'rgba(0,0,0,0.20)', badgeBg: 'rgba(0,105,79,0.12)', badgeEdge: '#00694f',
  lut: [[0, 105, 79], [0, 68, 170], [140, 0, 140]],
  trackHalo: 'rgba(0,0,0,0.35)', trackCasing: 'rgba(0,0,0,0.88)', wpRing: 'rgba(255,255,255,0.95)',
  endRing: '#000000', edgeShade: 'rgba(0,0,0,0.25)'
};
const MATRIX: CanvasPalette = {
  panel: '#020805', text: '#d6ffe5', muted: '#8fbca1', faint: '#5f8f72',
  accent: '#39ff88', accentSoft: 'rgba(57,255,136,0.10)', accentLine: 'rgba(57,255,136,0.32)', amber: '#ffd166',
  vectorBg: '#000300', grid: 'rgba(57,255,136,0.10)', cellBg: 'rgba(57,255,136,0.06)',
  progressTrack: 'rgba(57,255,136,0.18)', badgeBg: 'rgba(57,255,136,0.11)', badgeEdge: 'rgba(57,255,136,0.68)',
  lut: [[0, 112, 56], [24, 220, 112], [180, 255, 214]],
  trackHalo: 'rgba(0,0,0,0.46)', trackCasing: 'rgba(0,32,14,0.88)', wpRing: 'rgba(2,8,5,0.92)',
  endRing: 'rgba(214,255,229,0.95)', edgeShade: 'rgba(0,0,0,0.42)'
};
const NEON: CanvasPalette = {
  panel: '#080b1c', text: '#f4f7ff', muted: '#9ba5c9', faint: '#626b91',
  accent: '#ff3bd4', accentSoft: 'rgba(255,59,212,0.13)', accentLine: 'rgba(40,240,255,0.44)', amber: '#28f0ff',
  vectorBg: '#060819', grid: 'rgba(40,240,255,0.11)', cellBg: 'rgba(155,165,201,0.08)',
  progressTrack: 'rgba(40,240,255,0.18)', badgeBg: 'rgba(255,59,212,0.12)', badgeEdge: 'rgba(255,59,212,0.65)',
  lut: [[255, 59, 212], [40, 240, 255], [129, 140, 255]],
  trackHalo: 'rgba(255,59,212,0.20)', trackCasing: 'rgba(4,6,20,0.90)', wpRing: 'rgba(8,11,28,0.94)',
  endRing: 'rgba(244,247,255,0.94)', edgeShade: 'rgba(2,3,12,0.46)'
};
const STARSHIP: CanvasPalette = {
  panel: '#07111b', text: '#e3f5ff', muted: '#8ca8b8', faint: '#526f80',
  accent: '#ffb547', accentSoft: 'rgba(255,181,71,0.12)', accentLine: 'rgba(91,202,255,0.38)', amber: '#ffdb8a',
  vectorBg: '#030b12', grid: 'rgba(91,202,255,0.11)', cellBg: 'rgba(140,168,184,0.08)',
  progressTrack: 'rgba(91,202,255,0.18)', badgeBg: 'rgba(255,181,71,0.10)', badgeEdge: 'rgba(255,181,71,0.62)',
  lut: [[255, 181, 71], [91, 202, 255], [227, 245, 255]],
  trackHalo: 'rgba(0,0,0,0.40)', trackCasing: 'rgba(3,11,18,0.90)', wpRing: 'rgba(7,17,27,0.94)',
  endRing: 'rgba(227,245,255,0.94)', edgeShade: 'rgba(1,6,11,0.42)'
};
const AURORA: CanvasPalette = {
  panel: '#101b31', text: '#eefcff', muted: '#a8c6ce', faint: '#74909d',
  accent: '#66f0c2', accentSoft: 'rgba(102,240,194,0.13)', accentLine: 'rgba(197,163,255,0.40)', amber: '#c5a3ff',
  vectorBg: '#081427', grid: 'rgba(102,240,194,0.09)', cellBg: 'rgba(238,252,255,0.07)',
  progressTrack: 'rgba(238,252,255,0.16)', badgeBg: 'rgba(102,240,194,0.12)', badgeEdge: 'rgba(102,240,194,0.58)',
  lut: [[102, 240, 194], [91, 169, 255], [197, 163, 255]],
  trackHalo: 'rgba(2,10,25,0.30)', trackCasing: 'rgba(5,13,29,0.86)', wpRing: 'rgba(16,27,49,0.92)',
  endRing: 'rgba(238,252,255,0.94)', edgeShade: 'rgba(2,8,20,0.38)'
};
const AMBER: CanvasPalette = {
  panel: '#100b03', text: '#ffd58a', muted: '#c89b4a', faint: '#87642d',
  accent: '#ffb000', accentSoft: 'rgba(255,176,0,0.12)', accentLine: 'rgba(255,176,0,0.40)', amber: '#ffe2a1',
  vectorBg: '#0b0702', grid: 'rgba(255,176,0,0.12)', cellBg: 'rgba(200,155,74,0.08)',
  progressTrack: 'rgba(255,176,0,0.18)', badgeBg: 'rgba(255,176,0,0.11)', badgeEdge: 'rgba(255,176,0,0.65)',
  lut: [[135, 83, 0], [255, 176, 0], [255, 226, 161]],
  trackHalo: 'rgba(0,0,0,0.46)', trackCasing: 'rgba(16,11,3,0.92)', wpRing: 'rgba(16,11,3,0.95)',
  endRing: 'rgba(255,226,161,0.94)', edgeShade: 'rgba(0,0,0,0.48)'
};
const DEEPSEA: CanvasPalette = {
  panel: '#020c16', text: '#c9fff5', muted: '#68a7ad', faint: '#3a6975',
  accent: '#00f5d4', accentSoft: 'rgba(0,245,212,0.12)', accentLine: 'rgba(88,166,255,0.40)', amber: '#58a6ff',
  vectorBg: '#010810', grid: 'rgba(0,245,212,0.09)', cellBg: 'rgba(104,167,173,0.08)',
  progressTrack: 'rgba(0,245,212,0.17)', badgeBg: 'rgba(0,245,212,0.11)', badgeEdge: 'rgba(0,245,212,0.60)',
  lut: [[0, 112, 138], [0, 245, 212], [88, 166, 255]],
  trackHalo: 'rgba(0,245,212,0.16)', trackCasing: 'rgba(1,8,16,0.92)', wpRing: 'rgba(2,12,22,0.95)',
  endRing: 'rgba(201,255,245,0.94)', edgeShade: 'rgba(0,4,10,0.46)'
};
const VERMILION: CanvasPalette = {
  panel: '#f3eee5', text: '#272522', muted: '#746b62', faint: '#a39789',
  accent: '#b33a2b', accentSoft: 'rgba(179,58,43,0.11)', accentLine: 'rgba(179,58,43,0.36)', amber: '#d98b3e',
  vectorBg: '#ede6da', grid: 'rgba(63,55,45,0.09)', cellBg: 'rgba(63,55,45,0.05)',
  progressTrack: 'rgba(63,55,45,0.18)', badgeBg: 'rgba(179,58,43,0.10)', badgeEdge: 'rgba(179,58,43,0.55)',
  lut: [[179, 58, 43], [89, 91, 82], [46, 112, 109]],
  trackHalo: 'rgba(63,55,45,0.22)', trackCasing: 'rgba(63,55,45,0.76)', wpRing: 'rgba(243,238,229,0.94)',
  endRing: 'rgba(39,37,34,0.88)', edgeShade: 'rgba(63,55,45,0.16)'
};

const baseUi: ThemeDefinition['ui'] = {
  bgElev: '#060606', bgCard: '#0b0b0b', bgInput: '#141414',
  border: 'rgba(255,255,255,0.10)', borderStrong: 'rgba(255,255,255,0.18)',
  accentStrong: '#22b894', accentInk: '#06251d', danger: '#f26d6d', info: '#5aa7f0',
  trackCasing: '#06251d', trackGap: '#8a8a8a',
  shadow1: '0 2px 10px rgba(0,0,0,0.22)', shadow2: '0 12px 40px rgba(0,0,0,0.38)',
  glass: 'rgba(0,0,0,0.86)', mapAttrib: 'rgba(0,0,0,0.70)',
  mapIconFilter: 'invert(1)', mapControlFilter: 'invert(0.85)'
};

export const THEME_DEFINITIONS: Record<ConcreteThemeId, ThemeDefinition> = {
  dark: {
    id: 'dark', labelKey: 'settings.themeDark', labels: { zh: '深色', en: 'Dark' }, colorScheme: 'dark', effect: 'dark', palette: DARK,
    ui: { ...baseUi, glass: 'rgba(0,0,0,0.86)' }
  },
  light: {
    id: 'light', labelKey: 'settings.themeLight', labels: { zh: '浅色', en: 'Light' }, colorScheme: 'light', effect: 'light', palette: LIGHT,
    ui: {
      ...baseUi, bgElev: '#ffffff', bgCard: '#ffffff', bgInput: '#e9efec', border: 'rgba(24,37,31,0.09)', borderStrong: 'rgba(24,37,31,0.16)',
      accentStrong: '#0e8669', accentInk: '#ffffff', danger: '#c02626', info: '#2563eb', trackCasing: '#ffffff', trackGap: '#b3beb8',
      shadow1: '0 1px 4px rgba(24,37,31,0.06)', shadow2: '0 12px 34px rgba(24,37,31,0.16)', glass: 'rgba(255,255,255,0.90)',
      mapAttrib: 'rgba(255,255,255,0.88)', mapIconFilter: 'none', mapControlFilter: 'none'
    }
  },
  contrast: {
    id: 'contrast', labelKey: 'settings.themeContrast', labels: { zh: '烈日', en: 'Blazing sun' }, colorScheme: 'light', effect: 'contrast', palette: CONTRAST,
    ui: {
      ...baseUi, bgElev: '#ffffff', bgCard: '#ffffff', bgInput: '#f2f2f2', border: '#000000', borderStrong: '#000000',
      accentStrong: '#00523d', accentInk: '#ffffff', danger: '#b00000', info: '#0044aa', trackCasing: '#ffffff', trackGap: '#000000',
      shadow1: 'none', shadow2: '0 6px 0 rgba(0,0,0,0.18)', glass: 'rgba(255,255,255,0.97)',
      mapAttrib: 'rgba(255,255,255,0.96)', mapIconFilter: 'none', mapControlFilter: 'none'
    }
  },
  matrix: {
    id: 'matrix', labelKey: 'settings.themeMatrix', labels: { zh: '矩阵', en: 'Matrix' }, colorScheme: 'dark', effect: 'matrix', palette: MATRIX,
    ui: {
      ...baseUi, bgElev: '#020805', bgCard: '#03110a', bgInput: '#061b10', border: 'rgba(57,255,136,0.18)', borderStrong: 'rgba(57,255,136,0.34)',
      accentStrong: '#1de879', accentInk: '#002b16', danger: '#ff6b7a', info: '#5ad7ff', trackCasing: '#002b16', trackGap: '#3d6b50',
      radiusLg: '14px', radius: '10px', radiusSm: '6px', fontNum: 'var(--mono)',
      shadow1: '0 2px 14px rgba(0,0,0,0.45),0 0 18px rgba(57,255,136,0.07)', shadow2: '0 18px 48px rgba(0,0,0,0.62),0 0 32px rgba(57,255,136,0.09)',
      glass: 'rgba(2,8,5,0.94)', mapAttrib: 'rgba(0,20,8,0.92)', mapControlFilter: 'invert(0.85) sepia(0.3) saturate(1.6) hue-rotate(65deg)'
    }
  },
  neon: {
    id: 'neon', labelKey: 'settings.themeNeon', labels: { zh: '霓虹', en: 'Neon' }, colorScheme: 'dark', effect: 'neon', palette: NEON,
    ui: {
      ...baseUi, bgElev: '#0c1026', bgCard: '#10152e', bgInput: '#171d3c', border: 'rgba(40,240,255,0.22)', borderStrong: 'rgba(255,59,212,0.48)',
      accentStrong: '#ff71df', accentInk: '#16051a', danger: '#ff5b7f', info: '#28f0ff', trackCasing: '#080b1c', trackGap: '#4c5681',
      shadow1: '0 0 18px rgba(255,59,212,0.12)', shadow2: '0 0 34px rgba(40,240,255,0.18)', glass: 'rgba(8,11,28,0.90)',
      radiusLg: '18px', radius: '12px', radiusSm: '7px', fontNum: 'var(--mono)',
      mapAttrib: 'rgba(6,8,25,0.92)', mapControlFilter: 'invert(0.9) sepia(0.25) saturate(1.8) hue-rotate(65deg)'
    }
  },
  starship: {
    id: 'starship', labelKey: 'settings.themeStarship', labels: { zh: '星舰', en: 'Starship' }, colorScheme: 'dark', effect: 'starship', palette: STARSHIP,
    ui: {
      ...baseUi, bgElev: '#0b1a26', bgCard: '#102330', bgInput: '#16303f', border: 'rgba(91,202,255,0.22)', borderStrong: 'rgba(91,202,255,0.44)',
      accentStrong: '#ffc56f', accentInk: '#14202a', danger: '#ff6b6b', info: '#5bcaff', trackCasing: '#030b12', trackGap: '#466274',
      shadow1: '0 2px 12px rgba(0,0,0,0.34)', shadow2: '0 16px 42px rgba(0,10,20,0.52)', glass: 'rgba(7,17,27,0.92)',
      radiusLg: '8px', radius: '6px', radiusSm: '3px', fontNum: 'var(--mono)',
      mapAttrib: 'rgba(3,11,18,0.93)', mapControlFilter: 'invert(0.9) sepia(0.2) saturate(1.3)'
    }
  },
  aurora: {
    id: 'aurora', labelKey: 'settings.themeAurora', labels: { zh: '极光', en: 'Aurora' }, colorScheme: 'dark', effect: 'aurora', palette: AURORA,
    ui: {
      ...baseUi, bgElev: '#14243b', bgCard: '#182b45', bgInput: '#203551', border: 'rgba(238,252,255,0.16)', borderStrong: 'rgba(102,240,194,0.38)',
      accentStrong: '#8af7d5', accentInk: '#08251f', danger: '#ff8fa3', info: '#91c8ff', trackCasing: '#081427', trackGap: '#5f7d91',
      shadow1: '0 8px 28px rgba(2,8,20,0.30)', shadow2: '0 18px 48px rgba(2,8,20,0.46)', glass: 'rgba(16,27,49,0.78)',
      radiusLg: '22px', radius: '16px', radiusSm: '11px', mapAttrib: 'rgba(8,20,39,0.90)', mapControlFilter: 'invert(0.88)'
    }
  },
  amber: {
    id: 'amber', labelKey: 'settings.themeAmber', labels: { zh: '琥珀', en: 'Amber' }, colorScheme: 'dark', effect: 'amber', palette: AMBER,
    ui: {
      ...baseUi, bgElev: '#160f05', bgCard: '#1d1407', bgInput: '#2a1c09', border: 'rgba(255,176,0,0.25)', borderStrong: 'rgba(255,176,0,0.48)',
      accentStrong: '#ffc23d', accentInk: '#211400', danger: '#ff805c', info: '#ffd58a', trackCasing: '#100b03', trackGap: '#765526',
      shadow1: '0 0 16px rgba(255,176,0,0.10)', shadow2: '0 0 32px rgba(255,176,0,0.15)', glass: 'rgba(16,11,3,0.93)',
      radiusLg: '10px', radius: '7px', radiusSm: '4px', fontNum: 'var(--mono)',
      mapAttrib: 'rgba(16,11,3,0.94)', mapControlFilter: 'invert(0.85) sepia(0.7) saturate(2) hue-rotate(350deg)'
    }
  },
  deepsea: {
    id: 'deepsea', labelKey: 'settings.themeDeepsea', labels: { zh: '深海', en: 'Deep sea' }, colorScheme: 'dark', effect: 'deepsea', palette: DEEPSEA,
    ui: {
      ...baseUi, bgElev: '#041724', bgCard: '#061f2d', bgInput: '#082b3b', border: 'rgba(0,245,212,0.19)', borderStrong: 'rgba(88,166,255,0.40)',
      accentStrong: '#4dffe6', accentInk: '#00231f', danger: '#ff7892', info: '#58a6ff', trackCasing: '#010810', trackGap: '#34616e',
      shadow1: '0 6px 22px rgba(0,4,10,0.40)', shadow2: '0 18px 48px rgba(0,8,18,0.56)', glass: 'rgba(2,12,22,0.90)',
      radiusLg: '20px', radius: '14px', radiusSm: '9px', mapAttrib: 'rgba(1,8,16,0.93)', mapControlFilter: 'invert(0.86) sepia(0.2) saturate(1.5) hue-rotate(80deg)'
    }
  },
  vermilion: {
    id: 'vermilion', labelKey: 'settings.themeVermilion', labels: { zh: '朱砂', en: 'Vermilion' }, colorScheme: 'light', effect: 'vermilion', palette: VERMILION,
    ui: {
      ...baseUi, bgElev: '#f3eee5', bgCard: '#f8f4ed', bgInput: '#e8dfd2', border: 'rgba(63,55,45,0.18)', borderStrong: 'rgba(179,58,43,0.40)',
      accentStrong: '#92291e', accentInk: '#fff8ef', danger: '#a52a22', info: '#356f6d', trackCasing: '#f3eee5', trackGap: '#8e8172',
      shadow1: '0 2px 8px rgba(63,55,45,0.08)', shadow2: '0 12px 32px rgba(63,55,45,0.16)', glass: 'rgba(243,238,229,0.88)',
      radiusLg: '14px', radius: '10px', radiusSm: '5px', fontNum: '"Noto Serif CJK SC","Songti SC",serif',
      mapAttrib: 'rgba(243,238,229,0.94)', mapIconFilter: 'none', mapControlFilter: 'none'
    }
  }
};

export function themeDefinition(value: unknown): ThemeDefinition {
  return THEME_DEFINITIONS[isConcreteTheme(value) ? value : 'dark'];
}

export function appCssVars(value: unknown): Record<string, string> {
  const d = themeDefinition(value), p = d.palette, u = d.ui;
  return {
    'color-scheme': d.colorScheme,
    '--bg': p.vectorBg, '--bg-elev': u.bgElev, '--bg-card': u.bgCard, '--bg-input': u.bgInput,
    '--border': u.border, '--border-strong': u.borderStrong,
    '--text': p.text, '--text-dim': p.muted, '--text-faint': p.faint,
    '--accent': p.accent, '--accent-strong': u.accentStrong, '--accent-ink': u.accentInk, '--accent-soft': p.accentSoft,
    '--warn': p.amber, '--danger': u.danger, '--info': u.info,
    '--track': p.accent, '--track-casing': u.trackCasing, '--track-gap': u.trackGap,
    '--shadow-1': u.shadow1, '--shadow-2': u.shadow2,
    '--radius-lg': u.radiusLg || '16px', '--radius': u.radius || '12px', '--radius-sm': u.radiusSm || '8px',
    '--font-num': u.fontNum || '"Barlow Condensed","Bahnschrift","DIN Alternate",system-ui,sans-serif',
    '--map-attrib-bg': u.mapAttrib, '--map-icon-filter': u.mapIconFilter, '--map-control-filter': u.mapControlFilter,
    '--fx-primary': p.accent, '--fx-secondary': p.amber
  };
}

export function htmlCssVars(value: unknown): Record<string, string> {
  const d = themeDefinition(value), p = d.palette, u = d.ui;
  return {
    'color-scheme': d.colorScheme,
    '--bg': p.vectorBg, '--panel': p.panel, '--text': p.text, '--muted': p.muted, '--faint': p.faint,
    '--accent': p.accent, '--accent-soft': p.accentSoft, '--accent-ink': u.accentInk, '--amber': p.amber,
    '--chip': p.cellBg, '--border': u.border, '--border2': u.borderStrong, '--glass': u.glass, '--sheet': p.panel,
    '--shadow': u.shadow2, '--fx-primary': p.accent, '--fx-secondary': p.amber
  };
}

function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, alpha(color, a)); g.addColorStop(1, alpha(color, 0));
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
function grid(ctx: CanvasRenderingContext2D, w: number, h: number, color: string, step = 64, inset = 0) {
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = inset; x <= w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = inset; y <= h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
}
function scanlines(ctx: CanvasRenderingContext2D, w: number, h: number, color: string, step = 8) {
  ctx.fillStyle = color;
  for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, 1);
}

/** Shared, deterministic canvas backdrop for maps, posters, promos and recaps. */
export function paintThemeBackground(ctx: CanvasRenderingContext2D, w: number, h: number, value: unknown, phase = 0, showGrid = true) {
  const d = themeDefinition(value), p = d.palette;
  ctx.save();
  ctx.fillStyle = p.vectorBg; ctx.fillRect(0, 0, w, h);
  if (d.effect === 'dark' || d.effect === 'light') {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, p.panel); g.addColorStop(0.55, p.vectorBg); g.addColorStop(1, p.panel);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    glow(ctx, w * 0.88, h * 0.1, Math.max(w, h) * 0.52, p.accent, d.colorScheme === 'dark' ? 0.13 : 0.07);
    glow(ctx, w * 0.06, h * 0.9, Math.max(w, h) * 0.42, p.amber, d.colorScheme === 'dark' ? 0.06 : 0.04);
    if (showGrid) grid(ctx, w, h, p.grid, 96);
  } else if (d.effect === 'contrast') {
    ctx.fillStyle = p.panel; ctx.fillRect(0, 0, w, h);
    glow(ctx, w * 0.08, h * 0.06, Math.max(w, h) * 0.72, p.amber, 0.08);
    ctx.strokeStyle = alpha(p.amber, 0.13); ctx.lineWidth = 2;
    for (let i = -8; i < 18; i++) { ctx.beginPath(); ctx.moveTo(w * 0.1, 0); ctx.lineTo(i * 110, h); ctx.stroke(); }
    if (showGrid) grid(ctx, w, h, p.grid, 96);
  } else if (d.effect === 'matrix') {
    glow(ctx, w * 0.86, h * 0.08, Math.max(w, h) * 0.52, p.accent, 0.13);
    if (showGrid) grid(ctx, w, h, p.grid, 64);
    ctx.font = `600 ${Math.max(12, Math.round(w / 55))}px ui-monospace,monospace`;
    ctx.fillStyle = alpha(p.accent, 0.09);
    const glyphs = 'アイウエオカキクケコ0123456789';
    for (let c = 0; c < Math.ceil(w / 72); c++) for (let r = 0; r < Math.ceil(h / 76); r++) {
      ctx.fillText(glyphs[(r * 7 + c * 3) % glyphs.length], c * 72 + 14, r * 76 + ((c * 37) % 52));
    }
    scanlines(ctx, w, h, alpha(p.panel, 0.34));
  } else if (d.effect === 'neon') {
    glow(ctx, w * 0.12, h * 0.08, w * 0.72, p.accent, 0.22);
    glow(ctx, w * 0.9, h * 0.38, w * 0.66, p.amber, 0.18);
    if (showGrid) {
      grid(ctx, w, h, p.grid, 64);
      ctx.strokeStyle = alpha(p.amber, 0.20); ctx.beginPath();
      for (let x = -w; x < w * 2; x += 90) { ctx.moveTo(w / 2, h * 0.58); ctx.lineTo(x, h); }
      for (let y = h * 0.62; y < h; y += (y - h * 0.58) * 0.18) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
    }
    scanlines(ctx, w, h, 'rgba(2,3,12,0.30)');
  } else if (d.effect === 'starship') {
    const g = ctx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, alpha(p.amber, 0.07)); g.addColorStop(1, alpha(p.vectorBg, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (showGrid) {
      grid(ctx, w, h, p.grid, 48);
      ctx.strokeStyle = alpha(p.accent, 0.34); ctx.lineWidth = 2;
      const cx = w * 0.82, cy = h * 0.2, r = Math.min(w, h) * 0.19;
      for (const k of [1, 0.66, 0.33]) { ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
      ctx.strokeStyle = p.accentLine;
      const s = Math.min(54, w * 0.08);
      for (const [x, y, sx, sy] of [[24, 24, 1, 1], [w - 24, 24, -1, 1], [24, h - 24, 1, -1], [w - 24, h - 24, -1, -1]]) {
        ctx.beginPath(); ctx.moveTo(x, y + sy * s); ctx.lineTo(x, y); ctx.lineTo(x + sx * s, y); ctx.stroke();
      }
    }
  } else if (d.effect === 'aurora') {
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 4; i++) {
      const g = ctx.createLinearGradient(0, 0, w, h * 0.7);
      const colors = [p.accent, p.amber, '#5aa9ff', p.accent];
      g.addColorStop(0, alpha(colors[i], 0)); g.addColorStop(0.45, alpha(colors[i], 0.20)); g.addColorStop(1, alpha(colors[i], 0.03));
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-w * 0.1, h * (0.16 + i * 0.07));
      ctx.bezierCurveTo(w * 0.25, h * (-0.04 + i * 0.06) + Math.sin(phase + i) * h * 0.025, w * 0.65, h * (0.46 - i * 0.05), w * 1.1, h * (0.05 + i * 0.08));
      ctx.lineTo(w * 1.1, h * (0.24 + i * 0.08)); ctx.bezierCurveTo(w * 0.65, h * (0.62 - i * 0.05), w * 0.25, h * (0.12 + i * 0.06), -w * 0.1, h * (0.32 + i * 0.07)); ctx.closePath(); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    glow(ctx, w * 0.84, h * 0.86, w * 0.48, p.amber, 0.07);
    if (showGrid) grid(ctx, w, h, p.grid, 120);
  } else if (d.effect === 'amber') {
    glow(ctx, w * 0.5, h * 0.44, Math.max(w, h) * 0.7, p.accent, 0.11);
    if (showGrid) grid(ctx, w, h, alpha(p.accent, 0.055), 64);
    scanlines(ctx, w, h, 'rgba(0,0,0,0.26)');
    const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.7);
    v.addColorStop(0, alpha(p.vectorBg, 0)); v.addColorStop(1, 'rgba(0,0,0,0.52)'); ctx.fillStyle = v; ctx.fillRect(0, 0, w, h);
  } else if (d.effect === 'deepsea') {
    for (let i = 0; i < 4; i++) {
      const g = ctx.createRadialGradient(w * (0.15 + i * 0.25), h * (0.2 + (i % 2) * 0.5), 0, w * (0.15 + i * 0.25), h * (0.2 + (i % 2) * 0.5), w * 0.7);
      g.addColorStop(0, alpha(i % 2 ? p.amber : p.accent, 0.10)); g.addColorStop(1, alpha(p.vectorBg, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    }
    if (showGrid) grid(ctx, w, h, p.grid, 72);
    ctx.fillStyle = alpha(p.accent, 0.28);
    for (let i = 0; i < Math.min(90, Math.round(w / 10)); i++) {
      const x = (i * 157.31) % w, y = (i * 83.77 + Math.sin(phase + i) * 8) % h;
      ctx.beginPath(); ctx.arc(x, y, i % 7 === 0 ? 2 : 1, 0, Math.PI * 2); ctx.fill();
    }
  } else if (d.effect === 'vermilion') {
    for (let i = 0; i < 7; i++) {
      const x = (i * 0.19 + 0.06) * w, y = (i % 3 + 1) * h * 0.23;
      glow(ctx, x, y, Math.min(w, h) * (0.2 + (i % 2) * 0.08), i % 2 ? '#5c6f6b' : '#4b4035', 0.07);
    }
    ctx.strokeStyle = alpha(p.accent, 0.18); ctx.lineWidth = Math.max(1, w / 700);
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.ellipse(w * 0.82, h * 0.74, w * (0.12 + i * 0.025), h * (0.04 + i * 0.012), -0.35, 0, Math.PI * 1.6); ctx.stroke(); }
    if (showGrid) grid(ctx, w, h, p.grid, 128);
    const s = Math.min(78, w * 0.09), x = w - s * 1.7, y = h * 0.055;
    ctx.strokeStyle = alpha(p.accent, 0.82); ctx.lineWidth = 3; ctx.strokeRect(x, y, s, s);
    ctx.fillStyle = alpha(p.accent, 0.72); ctx.font = `700 ${s * 0.58}px "Songti SC",serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('迹', x + s / 2, y + s / 2 + 1);
  }
  ctx.restore();
}
