// Shared look for generated posters/videos/HTML. Only presentation: privacy and
// track geometry stay with their existing pipelines.

export const SHARE_BACKGROUNDS = ['theme', 'night', 'paper'] as const;
export const SHARE_FONTS = ['sans', 'serif', 'mono'] as const;
export const SHARE_LAYOUTS = ['stack', 'overlay'] as const;
export const SHARE_TRACK_COLORS = ['theme', 'teal', 'sky', 'amber', 'rose', 'white'] as const;
export const VIDEO_CAMERAS = ['auto', 'follow', 'aerial', 'overview'] as const;

export type ShareBackground = (typeof SHARE_BACKGROUNDS)[number];
export type ShareFont = (typeof SHARE_FONTS)[number];
export type ShareLayout = (typeof SHARE_LAYOUTS)[number];
export type ShareTrackColor = (typeof SHARE_TRACK_COLORS)[number];
export type VideoCamera = (typeof VIDEO_CAMERAS)[number];

export type ShareStyle = {
  background: ShareBackground;
  mapRatio: number;
  trackColor: ShareTrackColor;
  trackWidth: number;
  statsCard: boolean;
  title: string;
  font: ShareFont;
  layout: ShareLayout;
  camera: VideoCamera;
  photoCutIn: boolean;
};

export const SHARE_STYLE_DEFAULTS: ShareStyle = {
  background: 'theme',
  mapRatio: 60,
  trackColor: 'theme',
  trackWidth: 6.5,
  statsCard: true,
  title: '',
  font: 'sans',
  layout: 'stack',
  camera: 'auto',
  photoCutIn: true
};

const TRACK_HEX: Record<Exclude<ShareTrackColor, 'theme'>, string> = {
  teal: '#2bcda7',
  sky: '#38bdf8',
  amber: '#f5b942',
  rose: '#f472b6',
  white: '#f4f7f8'
};

const FONT_STACKS: Record<ShareFont, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif CJK SC", "Songti SC", "Source Han Serif SC", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace'
};

export function normalizeShareStyle(value: any = {}): ShareStyle {
  const v = value || {};
  return {
    background: SHARE_BACKGROUNDS.includes(v.background) ? v.background : SHARE_STYLE_DEFAULTS.background,
    mapRatio: Math.max(38, Math.min(72, Number(v.mapRatio) || SHARE_STYLE_DEFAULTS.mapRatio)),
    trackColor: SHARE_TRACK_COLORS.includes(v.trackColor) ? v.trackColor : SHARE_STYLE_DEFAULTS.trackColor,
    trackWidth: Math.max(3.5, Math.min(12, Number(v.trackWidth) || SHARE_STYLE_DEFAULTS.trackWidth)),
    statsCard: v.statsCard !== false,
    title: String(v.title || '').trim().slice(0, 24),
    font: SHARE_FONTS.includes(v.font) ? v.font : SHARE_STYLE_DEFAULTS.font,
    layout: SHARE_LAYOUTS.includes(v.layout) ? v.layout : SHARE_STYLE_DEFAULTS.layout,
    camera: VIDEO_CAMERAS.includes(v.camera) ? v.camera : SHARE_STYLE_DEFAULTS.camera,
    photoCutIn: v.photoCutIn !== false
  };
}

export function trackColorValue(value: ShareTrackColor, fallback = ''): string {
  return value === 'theme' ? fallback : TRACK_HEX[value] || fallback;
}

export function shareFontStack(value: ShareFont): string {
  return FONT_STACKS[value] || FONT_STACKS.sans;
}

export function posterLayout(size: string, style: ShareStyle) {
  const H = size === 'square' ? 1080 : 1920;
  const raw = size === 'square'
    ? Math.max(38, Math.min(56, style.mapRatio))
    : Math.max(40, Math.min(72, style.mapRatio));
  return { H, mapRatio: raw, mapH: Math.round((H * raw) / 100) };
}

export function squareStackLayout(H: number, mapH: number, showStats: boolean) {
  const brandY = H - 104;
  const profileY = mapH + (showStats ? 248 : 180);
  const profileBottom = brandY - 18;
  return { brandY, profileY, profileH: Math.max(96, profileBottom - profileY) };
}

export function squareOverlayLayout(H: number, mapH: number) {
  const overlap = 64;
  const cardX = 34, cardY = mapH - overlap, cardW = 1080 - 68, cardH = H - cardY - 30;
  const innerX = cardX + 28, innerY = cardY + 24, innerW = cardW - 56, innerH = cardH - 48;
  return { cardX, cardY, cardW, cardH, innerX, innerY, innerW, innerH };
}
