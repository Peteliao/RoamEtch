// Generic share promo (1080×1350): brand, product highlights, live-style route
// card and QR. Vector-only so it works offline and never contains trip data.
import { canvasPalette } from './palette';
import { drawBrandMark, drawQr, loadBrandFonts, SITE_URL, SPORT_FONT } from './brand';
import { roundRectPath } from './tripScore';
import { t } from './i18n';
import { effectiveTheme } from './theme';
import { paintThemeBackground } from './themeRegistry';
import { APP_VERSION } from './version';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const W = 1080;
const H = 1350;
const M = 72;
const CARD_PAD = 38;
const CARD_RADIUS = 24;
const INNER_RADIUS = 16;
const ICON_RADIUS = 12;
const QR_BG = '#edf7f2';

const AUDIENCES = [
  { key: 'soloOutdoor', id: 'solo-outdoor', visual: 'privacy' },
  { key: 'roadCrews', id: 'road-crews', visual: 'crew' },
  { key: 'travelCreators', id: 'travel-creators', visual: 'creator' },
  { key: 'crossBorder', id: 'cross-border', visual: 'crossBorder' },
  { key: 'frontend', id: 'frontend-open-source', visual: 'frontend' },
  { key: 'athletes', id: 'endurance-athletes', visual: 'athlete' },
  { key: 'commuters', id: 'urban-commuters', visual: 'commute' },
  { key: 'family', id: 'family-outings', visual: 'family' },
  { key: 'overland', id: 'overland-vanlife', visual: 'overland' },
  { key: 'eventLeads', id: 'event-leads', visual: 'event' },
  { key: 'fieldResearch', id: 'field-researchers', visual: 'field' },
  { key: 'dataStewards', id: 'gpx-data-stewards', visual: 'data' },
  { key: 'yearlyMemory', id: 'yearly-memory', visual: 'yearly' },
  { key: 'nightOled', id: 'night-oled', visual: 'oled' },
  { key: 'dogWalkers', id: 'dog-walkers', visual: 'walk' },
  { key: 'siteVisits', id: 'site-visits', visual: 'site' },
  { key: 'lovedOnes', id: 'loved-ones', visual: 'loved' }
] as const;

const BASE_LABEL_KEYS = [
  'promo.labelOverview', 'promo.labelYear', 'promo.labelMeet', 'promo.labelAnalysis',
  'promo.labelVideo', 'promo.labelRecovery', 'promo.labelCity', 'promo.labelPrivacy'
];

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function headlineSize(ctx: CanvasRenderingContext2D, lines: string[], maxW: number, start = 88) {
  for (let size = start; size >= 42; size -= 2) {
    ctx.font = `800 ${size}px ${FONT}`;
    if (lines.every((line) => ctx.measureText(line).width <= maxW)) return size;
  }
  return 42;
}

function setFittedFont(
  ctx: CanvasRenderingContext2D, text: string, maxW: number,
  start: number, min: number, weight = 600, family = FONT
) {
  let size = start;
  while (size > min) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxW) return;
    size -= 1;
  }
  ctx.font = `${weight} ${min}px ${family}`;
}

export const PROMO_VARIANT_COUNT = 8 + AUDIENCES.length;
let lastVariant = -1;

function normalizeVariant(variant: number) {
  const n = Number.isFinite(variant) ? Math.trunc(variant) : 0;
  return ((n % PROMO_VARIANT_COUNT) + PROMO_VARIANT_COUNT) % PROMO_VARIANT_COUNT;
}

export function nextVariant(variant: number) {
  return (normalizeVariant(variant) + 1) % PROMO_VARIANT_COUNT;
}

function audienceAt(variant: number) {
  const index = normalizeVariant(variant) - 8;
  return index >= 0 ? AUDIENCES[index] : null;
}

export function promoVariantLabel(variant: number) {
  const v = normalizeVariant(variant);
  const audience = audienceAt(v);
  return audience ? t(`promo.audience.${audience.key}.label`) : t(BASE_LABEL_KEYS[v]);
}

export function pickPromoVariant(random = Math.random) {
  const pool = [];
  for (let i = 0; i < PROMO_VARIANT_COUNT; i++) if (i !== lastVariant) pool.push(i);
  const next = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  lastVariant = next;
  return next;
}

function secondaryInk(P, highContrast: boolean) {
  return highContrast ? P.text : P.muted;
}

function tertiaryInk(P, highContrast: boolean) {
  return highContrast ? P.text : rgba(P.text, 0.7);
}

function drawHeroCopy(ctx: CanvasRenderingContext2D, P, highContrast: boolean, copy: { eyebrow: string; l1: string; l2: string; s1: string; s2?: string }) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  setFittedFont(ctx, copy.eyebrow, W - M * 2 - 34, 17, 14, 700);
  const eyebrowW = ctx.measureText(copy.eyebrow).width + 34;
  roundRectPath(ctx, M, 202, eyebrowW, 36, 18);
  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = P.accentLine;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = P.accent;
  }
  ctx.fillText(copy.eyebrow, M + 17, 225);

  const headPx = headlineSize(ctx, [copy.l1, copy.l2], W - M * 2);
  const firstBaseline = 330;
  const secondBaseline = firstBaseline + Math.round(headPx * 1.1);
  ctx.fillStyle = P.text;
  ctx.font = `800 ${headPx}px ${FONT}`;
  ctx.fillText(copy.l1, M, firstBaseline);
  const secondWidth = ctx.measureText(copy.l2).width;
  if (highContrast) {
    roundRectPath(ctx, M - 18, secondBaseline - headPx * 0.96, secondWidth + 36, headPx * 1.18, 8);
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.accent;
  }
  ctx.font = `800 ${headPx}px ${FONT}`;
  ctx.save();
  if (!highContrast) {
    ctx.shadowColor = rgba(P.accent, 0.24);
    ctx.shadowBlur = 12;
  }
  ctx.fillText(copy.l2, M, secondBaseline);
  ctx.restore();

  const sub1Baseline = secondBaseline + (headPx >= 70 ? 62 : 54);
  ctx.fillStyle = secondaryInk(P, highContrast);
  setFittedFont(ctx, copy.s1, W - M * 2, 26, 20, 500);
  ctx.fillText(copy.s1, M, sub1Baseline, W - M * 2);
  if (copy.s2) {
    ctx.fillStyle = tertiaryInk(P, highContrast);
    setFittedFont(ctx, copy.s2, W - M * 2, 22, 17, 500);
    ctx.fillText(copy.s2, M, sub1Baseline + 40, W - M * 2);
  }
}

function drawBackgroundContours(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  ctx.save();
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.055) : rgba(P.muted, 0.075);
  ctx.lineWidth = 1.2;
  const rings = (cx: number, cy: number, rx: number, ry: number, rotation: number) => {
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx - i * 34, ry - i * 19, rotation, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  rings(W * 0.9, H * 0.12, 330, 180, -0.28);
  rings(W * 0.08, H * 0.72, 270, 150, 0.34);
  ctx.restore();
}

function drawBackground(ctx: CanvasRenderingContext2D, P, highContrast: boolean, theme: string) {
  paintThemeBackground(ctx, W, H, theme, 0, false);
  const veil = theme === 'matrix' ? 0.95 : highContrast ? 0.42 : 0.84;
  ctx.fillStyle = rgba(P.vectorBg, veil);
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W - 70, 40, 0, W - 70, 40, 760);
  glow.addColorStop(0, rgba(P.accent, highContrast ? 0.07 : 0.16));
  glow.addColorStop(1, rgba(P.accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  drawBackgroundContours(ctx, P, highContrast);
  ctx.fillStyle = P.accent;
  ctx.fillRect(0, 0, W, 7);
}

function drawHeader(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  drawBrandMark(ctx, M, 64, 64, { bg: P.panel, accent: P.accent, amber: P.amber, dot: P.text });
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const brand = t('app.name');
  ctx.fillStyle = P.text;
  ctx.font = `800 38px ${FONT}`;
  if (brand.startsWith('RoamEtch') && brand.length > 'RoamEtch'.length) {
    const latin = 'RoamEtch';
    const localized = brand.slice(latin.length);
    ctx.fillText(latin, M + 84, 105);
    ctx.fillText(localized, M + 84 + ctx.measureText(latin).width + 6, 105);
  } else {
    ctx.fillText(brand, M + 84, 105);
  }
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(t('app.tagline'), M + 85, 136);

  const slogan = t('app.slogan');
  ctx.fillStyle = tertiaryInk(P, highContrast);
  setFittedFont(ctx, slogan, W - M * 2, 22, 16, 600);
  ctx.fillText(slogan, M, 180, W - M * 2);

  const pill = t('promo.pill', { version: APP_VERSION });
  ctx.font = `600 21px ${FONT}`;
  const pw = ctx.measureText(pill).width + 40;
  roundRectPath(ctx, W - M - pw, 75, pw, 42, 21);
  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.badgeBg;
    ctx.fill();
    ctx.strokeStyle = P.badgeEdge;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = P.accent;
  }
  ctx.fillText(pill, W - M - pw + 20, 103);
}

function smoothPath(ctx: CanvasRenderingContext2D, pts: number[][]) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.quadraticCurveTo(pts[pts.length - 2][0], pts[pts.length - 2][1], last[0], last[1]);
}

function drawMapTexture(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P, highContrast: boolean) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (highContrast) {
    ctx.fillStyle = rgba(P.accent, 0.05);
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.08) : P.grid;
  ctx.lineWidth = 1;
  const colStep = highContrast ? 132 : 112;
  const rowStep = highContrast ? 104 : 88;
  for (let gx = x + 64; gx < x + w; gx += colStep) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.stroke();
  }
  for (let gy = y + 44; gy < y + h; gy += rowStep) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.13) : P.grid;
  ctx.lineWidth = 1.5;
  const contour = (cx: number, cy: number, rx: number, ry: number, rot: number) => {
    for (const k of [1, 0.62]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * k, ry * k, rot, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  contour(x + w * 0.78, y + h * 0.32, 190, 92, -0.28);
  ctx.restore();
}

function drawRouteCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M;
  const y = 572;
  const w = W - M * 2;
  const h = 400;

  if (highContrast) {
    roundRectPath(ctx, x + 10, y + 12, w, h, CARD_RADIUS);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fill();
  }
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  ctx.fillStyle = P.panel;
  ctx.fill();
  if (!highContrast) {
    ctx.fillStyle = P.cellBg;
    ctx.fill();
  }
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 3 : 1.5;
  ctx.stroke();

  ctx.save();
  roundRectPath(ctx, x + 18, y + 62, w - 36, h - 118, INNER_RADIUS);
  ctx.clip();
  drawMapTexture(ctx, x + 18, y + 62, w - 36, h - 118, P, highContrast);

  const pts = [
    [x + 150, y + 262],
    [x + 245, y + 212],
    [x + 340, y + 242],
    [x + 425, y + 170],
    [x + 530, y + 192],
    [x + 630, y + 130],
    [x + 735, y + 154],
    [x + 820, y + 106],
    [x + 888, y + 124]
  ];

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  smoothPath(ctx, pts);
  ctx.strokeStyle = rgba(P.accent, highContrast ? 0.16 : 0.2);
  ctx.lineWidth = highContrast ? 24 : 20;
  ctx.stroke();
  smoothPath(ctx, pts);
  ctx.strokeStyle = highContrast ? P.text : P.trackCasing;
  ctx.lineWidth = highContrast ? 10 : 9;
  ctx.stroke();
  smoothPath(ctx, pts);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = highContrast ? 5 : 4.5;
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  const marker = (px: number, py: number, color: string) => {
    ctx.beginPath();
    ctx.arc(px, py, 14, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, 0.16);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, 3.4, 0, Math.PI * 2);
    ctx.fillStyle = P.panel;
    ctx.fill();
  };
  marker(pts[0][0], pts[0][1], P.accent);
  marker(pts[pts.length - 1][0], pts[pts.length - 1][1], P.amber);
  for (const i of [3, 6]) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], 5.5, 0, Math.PI * 2);
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 2.4;
    ctx.stroke();
  }

  // card header: live dot + timer, points on the right
  const hx = x + CARD_PAD;
  const hy = y + 46;
  if (highContrast) {
    ctx.beginPath();
    ctx.arc(hx, hy - 7, 9, 0, Math.PI * 2);
    ctx.fillStyle = rgba(P.accent, 0.18);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(hx, hy - 7, highContrast ? 5.5 : 5, 0, Math.PI * 2);
  ctx.fillStyle = P.accent;
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = `700 20px ${FONT}`;
  const live = t('promo.cardLive');
  ctx.fillText(live, hx + 16, hy);
  const lw = ctx.measureText(live).width;
  ctx.fillStyle = P.text;
  ctx.font = `600 23px ${MONO}`;
  ctx.fillText('00:42:18', hx + 16 + lw + 16, hy);

  ctx.textAlign = 'right';
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(`1,284 ${t('panel.points')}`, x + w - CARD_PAD, hy);
  ctx.textAlign = 'left';

  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x + CARD_PAD, y + 318);
  ctx.lineTo(x + w - CARD_PAD, y + 318);
  ctx.stroke();

  drawStatGrid(ctx, P, highContrast, [
    { value: '12.8', unit: 'km', label: t('panel.distance') },
    { value: '486', unit: 'm', label: t('panel.ascent') },
    { value: '2:58', unit: '', label: t('panel.duration') }
  ], x + CARD_PAD, y + 358, w - CARD_PAD * 2, { valueSize: 36, labelSize: 19, labelOffset: 27 });
}

function featureGlyph(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const circle = (cx: number, cy: number, r: number) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  if (kind === 'shield') {
    ctx.stroke(new Path2D('M12 3 4.5 6v6c0 4.5 3.2 7.8 7.5 9 4.3-1.2 7.5-4.5 7.5-9V6L12 3Z'));
    ctx.stroke(new Path2D('m8.8 12 2.2 2.2 4.2-4.4'));
  } else if (kind === 'meet') {
    circle(9, 8, 3);
    circle(17, 9.2, 2.4);
    ctx.beginPath();
    ctx.moveTo(3.5, 20);
    ctx.bezierCurveTo(3.5, 17, 6, 14.8, 9, 14.8);
    ctx.bezierCurveTo(12, 14.8, 14.5, 17, 14.5, 20);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(15.4, 15.3);
    ctx.bezierCurveTo(18.2, 15.3, 20.4, 17.1, 20.4, 20);
    ctx.stroke();
  } else if (kind === 'calendar') {
    ctx.stroke(new Path2D('M4 6.5h16v14H4v-14Zm0 4.5h16M8 3.5v5m8-5v5'));
    ctx.fillStyle = color;
    ctx.fillRect(7.5, 14, 3, 2.2);
    ctx.fillRect(13.5, 14, 3, 2.2);
  } else if (kind === 'music') {
    ctx.beginPath();
    ctx.moveTo(9, 17.5);
    ctx.lineTo(9, 6);
    ctx.lineTo(19, 4);
    ctx.lineTo(19, 15.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(6.5, 17.5, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(16.5, 15.5, 2.6, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'route') {
    circle(5, 18.5, 2);
    circle(19, 5.5, 2);
    ctx.stroke(new Path2D('M7 18.5h5.5a4 4 0 0 0 0-8H10a4 4 0 0 1 0-8h7'));
  } else {
    ctx.stroke(new Path2D('m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15'));
  }
  ctx.restore();
}

function drawFeatures(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const features = [
    ['calendar', t('promo.f1t'), t('promo.f1d')],
    ['shield', t('promo.f2t'), t('promo.f2d')],
    ['meet', t('promo.f3t'), t('promo.f3d')],
    ['music', t('promo.f4t'), t('promo.f4d')]
  ];
  const colW = (W - M * 2 - 36) / 2;
  features.forEach(([kind, title, desc], i) => {
    const fx = M + (i % 2) * (colW + 36);
    const fy = 1002 + Math.floor(i / 2) * 94;
    roundRectPath(ctx, fx, fy, 46, 46, ICON_RADIUS);
    if (highContrast) {
      ctx.fillStyle = P.accent;
      ctx.fill();
    } else {
      ctx.fillStyle = P.accentSoft;
      ctx.fill();
      ctx.strokeStyle = P.accentLine;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    featureGlyph(ctx, kind, fx + 11, fy + 11, 24, highContrast ? P.panel : P.accent);

    ctx.textAlign = 'left';
    ctx.fillStyle = P.text;
    setFittedFont(ctx, title, colW - 62, 25, 18, 700);
    ctx.fillText(title, fx + 62, fy + 20, colW - 62);
    ctx.fillStyle = tertiaryInk(P, highContrast);
    setFittedFont(ctx, desc, colW - 62, 19, 15, 500);
    ctx.fillText(desc, fx + 62, fy + 48, colW - 62);
  });
}

function drawFooter(ctx: CanvasRenderingContext2D, P, highContrast: boolean, cta = t('promo.cta')) {
  const x = M, y = 1166, w = W - M * 2, h = 160;
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  ctx.fillStyle = highContrast ? P.accent : P.panel;
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.accent : P.accentLine;
  ctx.lineWidth = highContrast ? 2 : 1.5;
  ctx.stroke();

  const tileX = x + 16, tileY = y + 14, tileSize = 132;
  ctx.save();
  roundRectPath(ctx, tileX, tileY, tileSize, tileSize, INNER_RADIUS);
  ctx.clip();
  drawQr(ctx, SITE_URL, tileX + 4, tileY + 4, 124, QR_BG);
  ctx.restore();
  roundRectPath(ctx, tileX, tileY, tileSize, tileSize, INNER_RADIUS);
  ctx.strokeStyle = highContrast ? P.accent : P.accentLine;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const tx = tileX + tileSize + 24;
  const textW = x + w - tx - 24;
  ctx.textAlign = 'left';
  ctx.fillStyle = highContrast ? P.panel : P.text;
  setFittedFont(ctx, cta, textW, 32, 23, 800);
  ctx.fillText(cta, tx, y + 48, textW);
  ctx.fillStyle = highContrast ? P.panel : P.accent;
  setFittedFont(ctx, SITE_URL, textW, 23, 18, 600, SPORT_FONT);
  ctx.fillText(SITE_URL, tx, y + 84, textW);
  ctx.strokeStyle = highContrast ? rgba(P.panel, 0.35) : rgba(P.accent, 0.38);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tx, y + 93);
  ctx.lineTo(tx + ctx.measureText(SITE_URL).width, y + 93);
  ctx.stroke();
  ctx.fillStyle = highContrast ? rgba(P.panel, 0.82) : secondaryInk(P, highContrast);
  const footer = t('promo.footer');
  setFittedFont(ctx, footer, textW, 18, 14, 500);
  ctx.fillText(footer, tx, y + 124, textW);
}

function drawPanel(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  ctx.fillStyle = P.panel;
  ctx.fill();
  if (!highContrast) {
    ctx.fillStyle = P.cellBg;
    ctx.fill();
  }
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 3 : 1.5;
  roundRectPath(ctx, x, y, w, h, CARD_RADIUS);
  ctx.stroke();
}

function drawYearCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);

  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText(t('trips.footprintTitle'), x + 38, y + 54);

  const pill = t('promo.yPill');
  ctx.font = `600 19px ${FONT}`;
  const pw = ctx.measureText(pill).width + 40;
  roundRectPath(ctx, x + w - 38 - pw, y + 26, pw, 40, 20);
  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.badgeBg;
    ctx.fill();
    ctx.strokeStyle = P.badgeEdge;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = P.accent;
  }
  ctx.fillText(pill, x + w - 38 - pw + 20, y + 53);

  ctx.fillStyle = P.accent;
  ctx.font = `800 172px ${SPORT_FONT}`;
  ctx.fillText('12', x + 38, y + 272);
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText(t('promo.yMonthUnit'), x + 45, y + 306);

  const bars = [0.36, 0.58, 0.44, 0.72, 0.5, 0.86, 0.64, 1, 0.74, 0.56, 0.9, 0.68];
  const left = x + 350, right = x + w - 38;
  const base = y + 292, maxH = 172;
  const gap = 9;
  const bw = (right - left - gap * 11) / 12;
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.2) : P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, base);
  ctx.lineTo(right, base);
  ctx.stroke();
  bars.forEach((v, i) => {
    const bx = left + i * (bw + gap);
    const bh = Math.max(6, v * maxH);
    if (!highContrast) {
      const g = ctx.createLinearGradient(0, base - bh, 0, base);
      g.addColorStop(0, i === 7 ? rgba(P.amber, 0.92) : rgba(P.accent, 0.86));
      g.addColorStop(1, i === 7 ? rgba(P.amber, 0.3) : rgba(P.accent, 0.2));
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = i === 7 ? P.amber : P.accent;
    }
    roundRectPath(ctx, bx, base - bh, bw, bh, 7);
    ctx.fill();
    ctx.fillStyle = i === 7 ? (highContrast ? P.text : P.amber) : secondaryInk(P, highContrast);
    ctx.font = `${i === 7 ? '700' : '500'} 13px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1).padStart(2, '0'), bx + bw / 2, base + 26);
  });
  ctx.textAlign = 'left';

  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x + 38, y + 356);
  ctx.lineTo(x + w - 38, y + 356);
  ctx.stroke();

  drawStatGrid(ctx, P, highContrast, [
    { value: '128', unit: '', label: t('trips.sumTrips') },
    { value: '1,284', unit: 'km', label: t('analysis.distance'), accent: true },
    { value: '16,800', unit: 'm', label: t('analysis.ascent') },
    { value: '365', unit: '', label: t('trips.sumDays') }
  ], x + 38, y + 422, w - 76, { valueSize: 46, labelSize: 19, labelOffset: 34 });
}

function drawLock(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(12, 10.5, 5, Math.PI, 0);
  ctx.stroke();
  roundRectPath(ctx, 5.5, 10.5, 13, 10.5, 2.2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(12, 15.6, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawMeetCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawMapTexture(ctx, x + 18, y + 82, w - 36, h - 116, P, highContrast);

  if (highContrast) {
    ctx.beginPath();
    ctx.arc(x + 49, y + 45, 9, 0, Math.PI * 2);
    ctx.fillStyle = rgba(P.accent, 0.18);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x + 49, y + 45, 5, 0, Math.PI * 2);
  ctx.fillStyle = P.accent;
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = `700 21px ${FONT}`;
  ctx.fillText(t('promo.mOnline'), x + 66, y + 53);

  const enc = t('promo.mEnc');
  ctx.font = `600 19px ${FONT}`;
  const pw = ctx.measureText(enc).width + 64;
  roundRectPath(ctx, x + w - 38 - pw, y + 24, pw, 42, 21);
  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fill();
    drawLock(ctx, x + w - 38 - pw + 19, y + 35, 20, P.panel);
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.badgeBg;
    ctx.fill();
    ctx.strokeStyle = P.badgeEdge;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    drawLock(ctx, x + w - 38 - pw + 19, y + 35, 20, P.accent);
    ctx.fillStyle = P.accent;
  }
  ctx.fillText(enc, x + w - 38 - pw + 46, y + 53);

  const nodes: [number, number, string, string][] = [
    [x + 206, y + 254, P.accent, 'A'],
    [x + 472, y + 158, P.amber, 'B'],
    [x + 744, y + 274, P.accent, 'C']
  ];
  ctx.save();
  ctx.setLineDash([9, 11]);
  ctx.strokeStyle = rgba(P.accent, highContrast ? 0.55 : 0.4);
  ctx.lineWidth = 3;
  smoothPath(ctx, [[nodes[0][0], nodes[0][1]], [nodes[1][0], nodes[1][1]], [nodes[2][0], nodes[2][1]]]);
  ctx.stroke();
  ctx.restore();

  for (const [nx, ny, color, label] of nodes) {
    ctx.beginPath();
    ctx.arc(nx, ny, 54, 0, Math.PI * 2);
    ctx.fillStyle = rgba(color, highContrast ? 0.14 : 0.11);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.45);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(nx, ny, 34, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = P.panel;
    ctx.font = `800 27px ${SPORT_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, nx, ny + 1);
    ctx.textBaseline = 'alphabetic';
  }

  drawChips(ctx, P, highContrast, [t('promo.mChip1'), t('promo.mChip2'), t('promo.mChip3')], x + CARD_PAD, y + 404, w - CARD_PAD * 2);
}

function drawPill(ctx: CanvasRenderingContext2D, P, highContrast: boolean, label: string, x: number, y: number, height = 42) {
  ctx.font = `600 19px ${FONT}`;
  const width = ctx.measureText(label).width + 40;
  roundRectPath(ctx, x, y, width, height, height / 2);
  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
  } else {
    ctx.fillStyle = P.badgeBg;
    ctx.fill();
    ctx.strokeStyle = P.badgeEdge;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.fillStyle = P.accent;
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(label, x + 20, y + height / 2 + 7);
  return width;
}

function drawCardHeading(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, title: string, pill: string) {
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  setFittedFont(ctx, title, w * 0.58, 28, 21, 700);
  ctx.fillText(title, x + 38, y + 54, w * 0.58);
  ctx.font = `600 19px ${FONT}`;
  const pw = ctx.measureText(pill).width + 40;
  drawPill(ctx, P, highContrast, pill, x + w - 38 - pw, y + 26);
}

function drawChips(ctx: CanvasRenderingContext2D, P, highContrast: boolean, labels: string[], x: number, y: number, w: number) {
  const gap = 12;
  const cw = (w - gap * (labels.length - 1)) / labels.length;
  ctx.font = `600 20px ${FONT}`;
  labels.forEach((label, i) => {
    const cx = x + i * (cw + gap);
    roundRectPath(ctx, cx, y, cw, 46, 23);
    if (highContrast) {
      ctx.fillStyle = P.accent;
      ctx.fill();
      ctx.fillStyle = P.panel;
    } else {
      ctx.fillStyle = P.accentSoft;
      ctx.fill();
      ctx.strokeStyle = P.accentLine;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = P.accent;
    }
    setFittedFont(ctx, label, cw - 24, 20, 15, 600);
    ctx.textAlign = 'center';
    ctx.fillText(label, cx + cw / 2, y + 31, cw - 24);
  });
  ctx.textAlign = 'left';
}

function drawSteps(ctx: CanvasRenderingContext2D, P, highContrast: boolean, labels: string[], x: number, y: number, w: number) {
  const gap = 24;
  const cellW = (w - gap * (labels.length - 1)) / labels.length;
  ctx.textBaseline = 'alphabetic';
  labels.forEach((label, i) => {
    const cx = x + i * (cellW + gap);
    roundRectPath(ctx, cx, y, cellW, 48, 24);
    if (highContrast) {
      ctx.fillStyle = P.accent;
      ctx.fill();
      ctx.fillStyle = P.panel;
    } else {
      ctx.fillStyle = P.accentSoft;
      ctx.fill();
      ctx.strokeStyle = P.accentLine;
      ctx.lineWidth = 1.3;
      ctx.stroke();
      ctx.fillStyle = P.accent;
    }
    ctx.textAlign = 'left';
    ctx.font = `700 14px ${MONO}`;
    ctx.fillText(String(i + 1).padStart(2, '0'), cx + 15, y + 30);
    setFittedFont(ctx, label, cellW - 58, 18, 12, 600);
    ctx.fillText(label, cx + 46, y + 31, cellW - 58);
    if (i < labels.length - 1) {
      const ax = cx + cellW + 6;
      const ay = y + 24;
      ctx.strokeStyle = P.amber;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + gap - 12, ay);
      ctx.lineTo(ax + gap - 17, ay - 4);
      ctx.moveTo(ax + gap - 12, ay);
      ctx.lineTo(ax + gap - 17, ay + 4);
      ctx.stroke();
    }
  });
  ctx.textAlign = 'left';
  return { cellW, gap };
}

function drawStatGrid(
  ctx: CanvasRenderingContext2D, P, highContrast: boolean,
  stats: Array<{ value: string; unit: string; label: string; accent?: boolean }>,
  x: number, y: number, w: number,
  options: { valueSize?: number; labelSize?: number; labelOffset?: number } = {}
) {
  const valueSize = options.valueSize ?? 38;
  const labelSize = options.labelSize ?? 18;
  const labelOffset = options.labelOffset ?? 29;
  const cellW = w / stats.length;
  ctx.save();
  for (let i = 0; i < stats.length; i++) {
    const stat = stats[i];
    const cx = x + cellW * (i + 0.5);
    if (i > 0) {
      ctx.strokeStyle = highContrast ? rgba(P.text, 0.22) : P.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + i * cellW, y - 22);
      ctx.lineTo(x + i * cellW, y + labelOffset - 2);
      ctx.stroke();
    }
    const fittedSize = /[A-Za-z]/.test(stat.value) && stat.value.length >= 5 ? Math.min(valueSize, 30) : valueSize;
    ctx.font = `800 ${fittedSize}px ${SPORT_FONT}`;
    const valueW = ctx.measureText(stat.value).width;
    ctx.font = `600 ${Math.max(14, labelSize - 2)}px ${FONT}`;
    const unitW = stat.unit ? ctx.measureText(stat.unit).width + 6 : 0;
    const startX = cx - (valueW + unitW) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = stat.accent ? P.accent : P.text;
    ctx.font = `800 ${fittedSize}px ${SPORT_FONT}`;
    ctx.fillText(stat.value, startX, y);
    if (stat.unit) {
      ctx.fillStyle = highContrast ? P.accent : secondaryInk(P, highContrast);
      ctx.font = `600 ${Math.max(14, labelSize - 2)}px ${FONT}`;
      ctx.fillText(stat.unit, startX + valueW + 6, y - 2);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = secondaryInk(P, highContrast);
    setFittedFont(ctx, stat.label, cellW - 20, labelSize, 13, 500);
    ctx.fillText(stat.label, cx, y + labelOffset, cellW - 20);
  }
  ctx.restore();
}

function drawSyntheticPhoto(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P, highContrast: boolean) {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 14);
  ctx.clip();
  const sky = ctx.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, highContrast ? rgba(P.accent, 0.32) : rgba(P.accent, 0.22));
  sky.addColorStop(1, P.panel);
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.arc(x + w * 0.76, y + h * 0.27, h * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = P.amber;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x + w * 0.28, y + h * 0.36);
  ctx.lineTo(x + w * 0.52, y + h * 0.76);
  ctx.lineTo(x + w * 0.72, y + h * 0.48);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fillStyle = highContrast ? P.text : P.accent;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x + w * 0.38, y + h);
  ctx.lineTo(x + w * 0.64, y + h * 0.54);
  ctx.lineTo(x + w, y + h * 0.86);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fillStyle = highContrast ? P.accent : P.muted;
  ctx.fill();
  ctx.restore();
}

function drawActivityCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, t('promo.aTitle'), t('promo.aPill'));

  const left = x + 78, right = x + w - 78, top = y + 132, bottom = y + 306;
  ctx.font = `600 18px ${FONT}`;
  ctx.fillStyle = P.accent;
  ctx.fillText(t('promo.aElevation'), left, y + 96);
  ctx.fillStyle = P.amber;
  ctx.fillText(t('promo.aSpeed'), left + 132, y + 96);
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.2) : P.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const gy = top + (bottom - top) * i / 3;
    ctx.beginPath();
    ctx.moveTo(left, gy);
    ctx.lineTo(right, gy);
    ctx.stroke();
  }
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `500 15px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText('1,240 m', left - 12, top + 5);
  ctx.fillText('800 m', left - 12, bottom + 5);
  ctx.textAlign = 'left';
  ctx.fillStyle = P.amber;
  ctx.fillText('32 km/h', right + 12, top + 5);
  ctx.fillText('0', right + 12, bottom + 5);

  const elevation = [0.2, 0.34, 0.29, 0.52, 0.68, 0.61, 0.84, 0.74, 0.93, 0.79, 0.88, 0.96];
  const speed = [0.22, 0.4, 0.34, 0.57, 0.48, 0.66, 0.54, 0.78, 0.62, 0.86, 0.7, 0.9];
  const points = (values: number[]) => values.map((v, i) => {
    const px = left + (right - left) * i / (values.length - 1);
    const py = bottom - v * (bottom - top);
    return [px, py] as [number, number];
  });
  const elevPts = points(elevation);
  const speedPts = points(speed);
  const fill = ctx.createLinearGradient(0, top, 0, bottom);
  fill.addColorStop(0, rgba(P.accent, highContrast ? 0.2 : 0.16));
  fill.addColorStop(1, rgba(P.accent, 0));
  ctx.beginPath();
  ctx.moveTo(left, bottom);
  elevPts.forEach(([px, py]) => ctx.lineTo(px, py));
  ctx.lineTo(right, bottom);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  for (const [series, color] of [[elevPts, P.accent], [speedPts, P.amber]] as const) {
    smoothPath(ctx, series);
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  elevPts.forEach(([px, py], i) => {
    if (i % 3) return;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  drawChips(ctx, P, highContrast, [t('promo.aHike'), t('promo.aBike'), t('promo.aRun'), t('promo.aDrive')], x + CARD_PAD, y + 350, w - CARD_PAD * 2);
  drawStatGrid(ctx, P, highContrast, [
    { value: '8.6', unit: 'km', label: t('promo.aDistance') },
    { value: '642', unit: 'm', label: t('promo.aAscent') },
    { value: '28.4', unit: 'km/h', label: t('promo.aMaxSpeed') }
  ], x + CARD_PAD, y + 430, w - CARD_PAD * 2);
}

function drawRecapCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, t('promo.rTitle'), t('promo.rExport'));

  const vx = x + 38, vy = y + 88, vw = w - 76, vh = 264;
  ctx.save();
  roundRectPath(ctx, vx, vy, vw, vh, INNER_RADIUS);
  ctx.clip();
  ctx.fillStyle = P.panel;
  ctx.fillRect(vx, vy, vw, vh);
  drawMapTexture(ctx, vx, vy, vw, vh, P, highContrast);
  const route = [[vx + 96, vy + 184], [vx + 228, vy + 124], [vx + 382, vy + 166], [vx + 548, vy + 96], [vx + 730, vy + 146]];
  smoothPath(ctx, route);
  ctx.strokeStyle = rgba(P.accent, 0.18);
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.stroke();
  smoothPath(ctx, route);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  route.forEach(([px, py], i) => {
    ctx.beginPath();
    ctx.arc(px, py, i === 0 || i === route.length - 1 ? 10 : 7, 0, Math.PI * 2);
    ctx.fillStyle = i === route.length - 1 ? P.amber : P.accent;
    ctx.fill();
    ctx.strokeStyle = P.panel;
    ctx.lineWidth = 3;
    ctx.stroke();
  });

  roundRectPath(ctx, vx + 34, vy + 28, 236, 58, 12);
  ctx.fillStyle = P.panel;
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = `700 15px ${FONT}`;
  ctx.fillText(t('promo.rNodeLabel'), vx + 50, vy + 51);
  ctx.fillStyle = P.text;
  const note = t('promo.rNoteText');
  setFittedFont(ctx, note, 204, 17, 13, 500);
  ctx.fillText(note, vx + 50, vy + 75, 204);
  drawSyntheticPhoto(ctx, vx + vw - 218, vy + 26, 184, 104, P, highContrast);

  const cx = vx + vw * 0.51, cy = vy + 164;
  ctx.beginPath();
  ctx.arc(cx, cy, 39, 0, Math.PI * 2);
  ctx.fillStyle = rgba(P.panel, 0.88);
  ctx.fill();
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy - 13);
  ctx.lineTo(cx + 15, cy);
  ctx.lineTo(cx - 7, cy + 13);
  ctx.closePath();
  ctx.fillStyle = P.accent;
  ctx.fill();

  const tlY = vy + 226;
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(vx + 44, tlY);
  ctx.lineTo(vx + vw - 44, tlY);
  ctx.stroke();
  ctx.strokeStyle = P.accent;
  ctx.beginPath();
  ctx.moveTo(vx + 44, tlY);
  ctx.lineTo(vx + vw * 0.64, tlY);
  ctx.stroke();
  for (const [px, color] of [[vx + 44, P.accent], [vx + vw * 0.38, P.accent], [vx + vw * 0.64, P.amber], [vx + vw - 44, secondaryInk(P, highContrast)]] as const) {
    ctx.beginPath();
    ctx.arc(px, tlY, 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.fillStyle = P.muted;
  ctx.font = `600 15px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText('00:18 / 00:42', vx + vw - 44, vy + 252);
  ctx.restore();

  const items = [
    ['01', t('promo.rNodes'), t('promo.rNodesDesc')],
    ['02', t('promo.rNotes'), t('promo.rNotesDesc')],
    ['03', t('promo.rPhotos'), t('promo.rPhotosDesc')]
  ];
  const iw = (w - 76) / 3;
  items.forEach(([n, title, desc], i) => {
    const ix = x + 38 + i * iw;
    ctx.textAlign = 'left';
    ctx.fillStyle = P.accent;
    ctx.font = `700 17px ${MONO}`;
    ctx.fillText(n, ix, y + 396);
    ctx.fillStyle = P.text;
    ctx.font = `700 23px ${FONT}`;
    ctx.fillText(title, ix + 38, y + 396);
    ctx.fillStyle = tertiaryInk(P, highContrast);
    setFittedFont(ctx, desc, iw - 48, 18, 14, 500);
    ctx.fillText(desc, ix + 38, y + 426, iw - 48);
  });
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText(t('promo.rMusic'), x + 38, y + 466);
}

function drawRecoveryCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, t('promo.gTitle'), t('promo.gPill'));

  const stepsX = x + CARD_PAD;
  const stepsW = w - CARD_PAD * 2;
  const { cellW, gap } = drawSteps(ctx, P, highContrast,
    [t('promo.gBackground'), t('promo.gRelocated'), t('promo.gSegment')], stepsX, y + 82, stepsW);
  const gapLeft = stepsX + cellW + gap;
  const gapRight = gapLeft + cellW;
  const mapY = y + 148, mapH = 184;

  ctx.save();
  roundRectPath(ctx, x + 24, mapY, w - 48, mapH, INNER_RADIUS);
  ctx.clip();
  drawMapTexture(ctx, x + 24, mapY, w - 48, mapH, P, highContrast);
  ctx.fillStyle = rgba(P.amber, highContrast ? 0.14 : 0.09);
  ctx.fillRect(gapLeft, mapY + 8, gapRight - gapLeft, mapH - 16);
  ctx.save();
  ctx.setLineDash([7, 8]);
  ctx.strokeStyle = rgba(P.amber, 0.68);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(gapLeft, mapY + 8);
  ctx.lineTo(gapLeft, mapY + mapH - 8);
  ctx.moveTo(gapRight, mapY + 8);
  ctx.lineTo(gapRight, mapY + mapH - 8);
  ctx.stroke();
  ctx.restore();

  const before = [[x + 86, mapY + 124], [x + 170, mapY + 90], [x + 254, mapY + 112], [gapLeft, mapY + 72]];
  const after = [[gapRight, mapY + 118], [x + 704, mapY + 88], [x + 806, mapY + 54], [x + 884, mapY + 76]];
  for (const segment of [before, after]) {
    smoothPath(ctx, segment);
    ctx.strokeStyle = rgba(P.accent, 0.18);
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.stroke();
    smoothPath(ctx, segment);
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  const routeNode = (px: number, py: number, color: string, solid: boolean) => {
    ctx.beginPath();
    ctx.arc(px, py, solid ? 13 : 11, 0, Math.PI * 2);
    ctx.fillStyle = solid ? rgba(color, 0.16) : P.panel;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(px, py, solid ? 7 : 8, 0, Math.PI * 2);
    ctx.fillStyle = solid ? color : P.panel;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();
  };
  routeNode(before[0][0], before[0][1], P.accent, true);
  routeNode(before[before.length - 1][0], before[before.length - 1][1], P.amber, false);
  routeNode(after[0][0], after[0][1], P.accent, true);
  routeNode(after[after.length - 1][0], after[after.length - 1][1], P.accent, true);

  ctx.textAlign = 'center';
  ctx.fillStyle = P.amber;
  setFittedFont(ctx, t('promo.gGap'), gapRight - gapLeft - 24, 21, 15, 700);
  ctx.fillText(t('promo.gGap'), (gapLeft + gapRight) / 2, mapY + 82, gapRight - gapLeft - 24);
  ctx.fillStyle = secondaryInk(P, highContrast);
  setFittedFont(ctx, t('promo.gNoData'), gapRight - gapLeft - 24, 17, 13, 500);
  ctx.fillText(t('promo.gNoData'), (gapLeft + gapRight) / 2, mapY + 108, gapRight - gapLeft - 24);

  const statusTag = (cx: number, baseline: number, text: string, color: string) => {
    setFittedFont(ctx, text, 230, 17, 13, 700);
    const textW = ctx.measureText(text).width;
    const tagW = textW + 42;
    roundRectPath(ctx, cx - tagW / 2, baseline - 25, tagW, 34, 17);
    ctx.fillStyle = highContrast ? rgba(color, 0.12) : rgba(color, 0.1);
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.38);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - tagW / 2 + 15, baseline - 8, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.fillText(text, cx - tagW / 2 + 27, baseline - 4, 230);
  };
  statusTag(x + 170, mapY + 162, t('promo.gInterrupted'), P.amber);
  statusTag(gapRight + 136, mapY + 162, t('promo.gRestored'), P.accent);
  ctx.restore();

  const ry = y + 346;
  roundRectPath(ctx, x + CARD_PAD, ry, w - CARD_PAD * 2, 64, INNER_RADIUS);
  ctx.fillStyle = highContrast ? rgba(P.accent, 0.1) : P.accentSoft;
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.text : P.accentLine;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  featureGlyph(ctx, 'route', x + CARD_PAD + 18, ry + 18, 28, P.accent);
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  setFittedFont(ctx, t('promo.gRepair'), w - 170, 21, 17, 700);
  ctx.fillText(t('promo.gRepair'), x + CARD_PAD + 60, ry + 27, w - 170);
  ctx.fillStyle = secondaryInk(P, highContrast);
  setFittedFont(ctx, t('promo.gRepairValue'), w - 170, 18, 14, 500);
  ctx.fillText(t('promo.gRepairValue'), x + CARD_PAD + 60, ry + 51, w - 170);

  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + CARD_PAD, y + 426);
  ctx.lineTo(x + w - CARD_PAD, y + 426);
  ctx.stroke();

  drawStatGrid(ctx, P, highContrast, [
    { value: '1,284', unit: '', label: t('promo.gStatPoints') },
    { value: '03', unit: '', label: t('promo.gStatSegments') },
    { value: 'LOCAL', unit: '', label: t('promo.gStatLocal'), accent: true }
  ], x + CARD_PAD, y + 452, w - CARD_PAD * 2);
}

function drawCityCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, t('promo.cTitle'), t('promo.cPill'));

  const mx = x + 18, my = y + 80, mw = w - 36, mh = 316;
  ctx.save();
  roundRectPath(ctx, mx, my, mw, mh, INNER_RADIUS);
  ctx.clip();
  ctx.fillStyle = highContrast ? rgba(P.accent, 0.035) : P.cellBg;
  ctx.fillRect(mx, my, mw, mh);
  const roads = [
    [[mx - 30, my + 58], [mx + mw + 20, my + 208]],
    [[mx + 96, my - 20], [mx + 318, my + mh + 20]],
    [[mx + 488, my - 20], [mx + 676, my + mh + 20]],
    [[mx - 20, my + 244], [mx + mw + 20, my + 72]],
    [[mx - 20, my + 282], [mx + mw + 20, my + 282]]
  ];
  roads.forEach((road, i) => {
    smoothPath(ctx, road);
    ctx.strokeStyle = highContrast ? rgba(P.text, 0.16) : P.grid;
    ctx.lineWidth = i < 3 ? 13 : 8;
    ctx.stroke();
    smoothPath(ctx, road);
    ctx.strokeStyle = highContrast ? rgba(P.text, 0.28) : rgba(P.muted, 0.18);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  });
  const blocks = [
    [mx + 42, my + 30, 94, 58], [mx + 172, my + 22, 104, 82], [mx + 364, my + 36, 86, 64],
    [mx + 530, my + 28, 112, 74], [mx + 720, my + 30, 126, 62], [mx + 54, my + 132, 82, 68],
    [mx + 348, my + 132, 104, 74], [mx + 548, my + 144, 90, 66], [mx + 734, my + 136, 108, 72],
    [mx + 188, my + 224, 116, 54], [mx + 402, my + 236, 96, 48], [mx + 662, my + 224, 132, 44]
  ];
  blocks.forEach(([bx, by, bw, bh], i) => {
    roundRectPath(ctx, bx, by, bw, bh, 8);
    ctx.fillStyle = i % 3 === 0 ? P.accentSoft : (highContrast ? rgba(P.text, 0.05) : P.panel);
    ctx.fill();
    ctx.strokeStyle = highContrast ? rgba(P.text, 0.12) : P.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
  });
  const cities = [[0.18, 0.35], [0.36, 0.68], [0.54, 0.3], [0.7, 0.58], [0.84, 0.25], [0.9, 0.74]];
  const cityPts = cities.map(([px, py]) => [mx + mw * px, my + mh * py] as [number, number]);
  smoothPath(ctx, cityPts);
  ctx.strokeStyle = rgba(P.accent, 0.34);
  ctx.lineWidth = 2.5;
  ctx.setLineDash([7, 9]);
  ctx.stroke();
  ctx.setLineDash([]);
  cityPts.forEach(([cx, cy], i) => {
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 42);
    glow.addColorStop(0, rgba(i % 2 ? P.amber : P.accent, 0.32));
    glow.addColorStop(1, rgba(i % 2 ? P.amber : P.accent, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 42, cy - 42, 84, 84);
    ctx.beginPath();
    ctx.arc(cx, cy, 12, 0, Math.PI * 2);
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, 7, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? P.amber : P.accent;
    ctx.fill();
    ctx.fillStyle = P.text;
    ctx.font = `700 14px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1).padStart(2, '0'), cx, cy + 30);
  });
  ctx.textAlign = 'left';
  ctx.fillStyle = P.muted;
  ctx.font = `600 17px ${FONT}`;
  ctx.fillText(t('promo.cMapLabel'), mx + 24, my + 30);
  ctx.textAlign = 'right';
  ctx.fillStyle = P.text;
  ctx.font = `700 20px ${SPORT_FONT}`;
  ctx.fillText(t('promo.cCities', { n: 12 }), mx + mw - 24, my + 30);
  ctx.restore();

  const musicY = y + 414;
  roundRectPath(ctx, x + 38, musicY, 54, 54, 16);
  ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
  ctx.fill();
  featureGlyph(ctx, 'music', x + 50, musicY + 13, 30, highContrast ? P.panel : P.accent);
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(t('promo.cMusic'), x + 110, musicY + 23);
  ctx.fillStyle = secondaryInk(P, highContrast);
  const musicDesc = t('promo.cMusicDesc');
  setFittedFont(ctx, musicDesc, 540, 17, 13, 500);
  ctx.fillText(musicDesc, x + 110, musicY + 48, 540);
  const bars = [14, 28, 20, 38, 26, 34, 18, 30];
  bars.forEach((height, i) => {
    const bx = x + w - 206 + i * 19;
    roundRectPath(ctx, bx, musicY + 43 - height, 9, height, 4.5);
    ctx.fillStyle = i % 2 ? P.amber : P.accent;
    ctx.fill();
  });
}

function drawPrivacyCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, t('promo.pTitle'), t('promo.pPill'));

  const mx = x + 38, my = y + 94, mw = 500, mh = 292;
  ctx.save();
  roundRectPath(ctx, mx, my, mw, mh, INNER_RADIUS);
  ctx.clip();
  ctx.fillStyle = highContrast ? rgba(P.accent, 0.04) : P.cellBg;
  ctx.fillRect(mx, my, mw, mh);
  drawMapTexture(ctx, mx, my, mw, mh, P, highContrast);
  const route = [[mx + 64, my + 220], [mx + 152, my + 164], [mx + 244, my + 190], [mx + 336, my + 112], [mx + 438, my + 72]];
  smoothPath(ctx, route);
  ctx.strokeStyle = rgba(P.text, highContrast ? 0.16 : 0.1);
  ctx.lineWidth = 5;
  ctx.setLineDash([5, 9]);
  ctx.stroke();
  ctx.setLineDash([]);
  const visible = [[mx + 148, my + 168], [mx + 244, my + 190], [mx + 336, my + 112], [mx + 356, my + 103]];
  smoothPath(ctx, visible);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.stroke();
  for (const [cx, cy] of [[mx + 64, my + 220], [mx + 438, my + 72]]) {
    ctx.beginPath();
    ctx.arc(cx, cy, 72, 0, Math.PI * 2);
    ctx.fillStyle = rgba(P.accent, highContrast ? 0.12 : 0.08);
    ctx.fill();
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawLock(ctx, cx - 12, cy - 12, 24, P.accent);
  }
  ctx.beginPath();
  ctx.arc(mx + 244, my + 190, 12, 0, Math.PI * 2);
  ctx.fillStyle = P.panel;
  ctx.fill();
  ctx.strokeStyle = P.amber;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = P.amber;
  ctx.font = `700 14px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText(t('promo.pSensitiveShort'), mx + 244, my + 224);
  ctx.fillStyle = secondaryInk(P, highContrast);
  ctx.font = `600 16px ${FONT}`;
  ctx.fillText(t('promo.pMapNote'), mx + mw / 2, my + mh - 20);
  ctx.restore();

  const items = [
    t('promo.pCircle'), t('promo.pLocal'), t('promo.pBackup'), t('promo.pSensitive')
  ];
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(t('promo.pCheck'), x + 574, y + 116);
  items.forEach((label, i) => {
    const iy = y + 148 + i * 62;
    ctx.beginPath();
    ctx.arc(x + 590, iy - 7, 14, 0, Math.PI * 2);
    ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = highContrast ? P.accent : P.accentLine;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 584, iy - 7);
    ctx.lineTo(x + 589, iy - 2);
    ctx.lineTo(x + 597, iy - 13);
    ctx.strokeStyle = highContrast ? P.panel : P.accent;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = P.text;
    setFittedFont(ctx, label, w - 612, 20, 15, 600);
    ctx.fillText(label, x + 616, iy, w - 612);
  });

  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 2 : 1;
  ctx.beginPath();
  ctx.moveTo(x + 38, y + 416);
  ctx.lineTo(x + w - 38, y + 416);
  ctx.stroke();
  ctx.fillStyle = P.accent;
  ctx.font = `700 21px ${FONT}`;
  ctx.fillText(t('promo.pBottom'), x + 38, y + 456);
  ctx.textAlign = 'right';
  ctx.fillStyle = P.muted;
  ctx.font = `600 18px ${MONO}`;
  ctx.fillText(t('promo.pNoAccount'), x + w - 38, y + 456);
  ctx.textAlign = 'left';
}

type AudienceCopy = {
  label: string; eyebrow: string; l1: string; l2: string; s1: string; s2: string;
  features: [string, string, string]; cta: string;
};

function audienceCopy(variant: number): AudienceCopy {
  const audience = audienceAt(variant)!;
  const prefix = `promo.audience.${audience.key}`;
  return {
    label: t(`${prefix}.label`), eyebrow: t(`${prefix}.eyebrow`),
    l1: t(`${prefix}.headline1`), l2: t(`${prefix}.headline2`),
    s1: t(`${prefix}.sub1`), s2: t(`${prefix}.sub2`),
    features: [t(`${prefix}.feature1`), t(`${prefix}.feature2`), t(`${prefix}.feature3`)],
    cta: t(`${prefix}.cta`)
  };
}

function wrapCanvasText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines = 2) {
  const tokens = text.includes(' ') ? text.split(/\s+/) : Array.from(text);
  const lines: string[] = [];
  let line = '';
  for (const token of tokens) {
    const candidate = line ? `${line}${text.includes(' ') ? ' ' : ''}${token}` : token;
    if (ctx.measureText(candidate).width <= maxW) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = token;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const used = lines.join(text.includes(' ') ? ' ' : '');
  if (used !== text && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '…';
  }
  return lines;
}

function drawAudienceFeatures(ctx: CanvasRenderingContext2D, P, highContrast: boolean, features: [string, string, string], x: number, y: number, w: number) {
  const gap = 18;
  const cw = (w - gap * 2) / 3;
  ctx.font = `600 19px ${FONT}`;
  features.forEach((feature, i) => {
    const fx = x + i * (cw + gap);
    ctx.beginPath();
    ctx.arc(fx + 13, y + 13, 13, 0, Math.PI * 2);
    ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = highContrast ? P.accent : P.accentLine;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    ctx.strokeStyle = highContrast ? P.panel : P.accent;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(fx + 7, y + 13);
    ctx.lineTo(fx + 11, y + 17);
    ctx.lineTo(fx + 19, y + 8);
    ctx.stroke();
    const lines = wrapCanvasText(ctx, feature, cw - 40, 3);
    ctx.fillStyle = P.text;
    ctx.textAlign = 'left';
    lines.forEach((line, index) => ctx.fillText(line, fx + 36, y + 10 + index * 24));
  });
}

function drawAudienceNode(ctx: CanvasRenderingContext2D, P, x: number, y: number, label: string, color = P.accent, radius = 30) {
  ctx.beginPath();
  ctx.arc(x, y, radius + 12, 0, Math.PI * 2);
  ctx.fillStyle = rgba(color, 0.12);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = P.panel;
  ctx.font = `800 ${Math.round(radius * 0.8)}px ${SPORT_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + 1);
  ctx.textBaseline = 'alphabetic';
}

function drawMiniFile(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number, label: string) {
  roundRectPath(ctx, x, y, w, h, 16);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = P.accent;
  ctx.font = `700 18px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 20, y + 36);
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.25) : P.grid;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(x + 20, y + 58 + i * 18);
    ctx.lineTo(x + w - 20 - (i % 2) * 34, y + 58 + i * 18);
    ctx.stroke();
  }
}

function drawPrivacyAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const mapW = w * 0.64;
  drawMapTexture(ctx, x + 12, y + 12, mapW, h - 24, P, highContrast);
  const route = [[x + 66, y + h - 58], [x + 142, y + h - 118], [x + 238, y + 96], [x + 342, y + 142], [x + 456, y + 56]];
  smoothPath(ctx, route);
  ctx.strokeStyle = rgba(P.text, 0.22);
  ctx.lineWidth = 5;
  ctx.setLineDash([6, 9]);
  ctx.stroke();
  ctx.setLineDash([]);
  smoothPath(ctx, route.slice(1, 4));
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.stroke();
  for (const [px, py] of [route[0], route[route.length - 1]]) {
    ctx.beginPath();
    ctx.arc(px, py, 58, 0, Math.PI * 2);
    ctx.fillStyle = rgba(P.accent, 0.09);
    ctx.fill();
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 7]);
    ctx.stroke();
    ctx.setLineDash([]);
    drawLock(ctx, px - 12, py - 12, 24, P.accent);
  }
  const cx = x + mapW + 38;
  drawMiniFile(ctx, P, highContrast, cx, y + 28, w - mapW - 70, 150, 'IndexedDB');
  ctx.fillStyle = P.accent;
  ctx.font = `800 34px ${SPORT_FONT}`;
  ctx.fillText('LOCAL', cx + 20, y + 150);
  drawPill(ctx, P, highContrast, 'EXIF', cx, y + 202, 40);
  drawPill(ctx, P, highContrast, 'WGS-84', cx + 112, y + 202, 40);
}

function drawCrewAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y, w, h, P, highContrast);
  const nodes = [[x + 168, y + 180, 'A'], [x + 438, y + 92, 'B'], [x + 704, y + 184, 'C']] as const;
  smoothPath(ctx, nodes.map(([px, py]) => [px, py]));
  ctx.strokeStyle = rgba(P.accent, 0.28);
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.stroke();
  smoothPath(ctx, nodes.map(([px, py]) => [px, py]));
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  nodes.forEach(([px, py, label], i) => drawAudienceNode(ctx, P, px, py, label, i === 1 ? P.amber : P.accent));
  roundRectPath(ctx, x + 340, y + 132, 196, 62, 18);
  ctx.fillStyle = P.panel;
  ctx.fill();
  ctx.strokeStyle = P.accentLine;
  ctx.stroke();
  ctx.fillStyle = P.text;
  ctx.font = `600 17px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('ENCRYPTED CHAT', x + 438, y + 170);
  drawPill(ctx, P, highContrast, '1 / 2 / 4 / 8h', x + w - 214, y + 22, 40);
}

function drawCreatorAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const cards = [
    { cx: x + 176, cy: y + 144, angle: -0.08, label: 'POSTER' },
    { cx: x + 442, cy: y + 142, angle: 0.02, label: 'VIDEO' },
    { cx: x + 700, cy: y + 144, angle: 0.09, label: 'HTML' }
  ];
  cards.forEach(({ cx, cy, angle, label }, i) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    roundRectPath(ctx, -112, -116, 224, 232, 20);
    ctx.fillStyle = highContrast ? P.panel : P.cellBg;
    ctx.fill();
    ctx.strokeStyle = i === 1 ? P.amber : P.accentLine;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (i === 0) {
      smoothPath(ctx, [[-76, 54], [-28, -2], [18, 28], [72, -42]]);
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 5;
      ctx.stroke();
    } else if (i === 1) {
      ctx.beginPath();
      ctx.arc(0, 0, 42, 0, Math.PI * 2);
      ctx.fillStyle = rgba(P.amber, 0.16);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-10, -18);
      ctx.lineTo(22, 0);
      ctx.lineTo(-10, 18);
      ctx.closePath();
      ctx.fillStyle = P.amber;
      ctx.fill();
    } else {
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-52, -36);
      ctx.lineTo(-12, -8);
      ctx.lineTo(20, -42);
      ctx.lineTo(58, -12);
      ctx.stroke();
      ctx.fillStyle = P.muted;
      ctx.font = `600 14px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText('</trip>', 0, 42);
    }
    ctx.fillStyle = P.text;
    ctx.font = `700 18px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, 0, 94);
    ctx.restore();
  });
}

function drawCrossBorderAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const cx = x + 218, cy = y + h / 2, r = 118;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  for (const k of [0.35, 0.7]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * k, r, 0, 0, Math.PI * 2);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const k of [0.35, 0.7]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * k, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  drawAudienceNode(ctx, P, cx - 52, cy - 38, 'CN', P.accent, 24);
  drawAudienceNode(ctx, P, cx + 64, cy + 34, 'G', P.amber, 24);
  const fx = x + 420;
  drawMiniFile(ctx, P, highContrast, fx, y + 28, 190, 104, 'WGS-84');
  drawMiniFile(ctx, P, highContrast, fx + 218, y + 28, 190, 104, 'GPX');
  roundRectPath(ctx, fx, y + 164, 408, 76, 18);
  ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
  ctx.fill();
  drawLock(ctx, fx + 22, y + 182, 36, highContrast ? P.panel : P.accent);
  ctx.fillStyle = highContrast ? P.panel : P.text;
  ctx.font = `700 21px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('AES-256-GCM BACKUP', fx + 76, y + 210);
}

function drawFrontendAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  roundRectPath(ctx, x + 20, y + 20, 452, h - 40, 18);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ['#ff6b6b', P.amber, P.accent].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(x + 46 + i * 22, y + 44, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  const lines = ['const trip = await store.load(id)', 'map = new MapLibre({ canvas })', 'key = await crypto.subtle.importKey()', 'peer = new RTCPeerConnection()', 'mqtt.publish(encryptedPayload)'];
  ctx.font = `500 16px ${MONO}`;
  lines.forEach((line, i) => {
    ctx.fillStyle = i % 2 ? P.muted : P.accent;
    ctx.fillText(line, x + 44, y + 84 + i * 31);
  });
  const labels = ['TS + DOM', 'MAPLIBRE', 'WEB CRYPTO'];
  labels.forEach((label, i) => {
    const ny = y + 54 + i * 76;
    if (i < labels.length - 1) {
      ctx.strokeStyle = P.accentLine;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + 634, ny + 24);
      ctx.lineTo(x + 634, ny + 52);
      ctx.stroke();
    }
    roundRectPath(ctx, x + 528, ny, 212, 48, 14);
    ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
    ctx.fill();
    ctx.fillStyle = highContrast ? P.panel : P.accent;
    ctx.font = `700 18px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 634, ny + 31);
  });
}

function drawAthleteAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawChips(ctx, P, highContrast, ['HIKE', 'TRAIL RUN', 'RIDE'], x + 20, y + 18, 430);
  const left = x + 58, right = x + w - 58, top = y + 88, bottom = y + h - 48;
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const gy = top + (bottom - top) * i / 3;
    ctx.beginPath();
    ctx.moveTo(left, gy);
    ctx.lineTo(right, gy);
    ctx.stroke();
  }
  const values = [0.18, 0.34, 0.29, 0.56, 0.72, 0.62, 0.88, 0.76, 0.94, 0.82, 0.9, 0.98];
  const pts = values.map((v, i) => [left + (right - left) * i / (values.length - 1), bottom - v * (bottom - top)] as [number, number]);
  smoothPath(ctx, pts);
  ctx.strokeStyle = rgba(P.accent, 0.16);
  ctx.lineWidth = 18;
  ctx.stroke();
  smoothPath(ctx, pts);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  const pace = values.map((v, i) => [left + (right - left) * i / (values.length - 1), bottom - (1 - v * 0.68) * (bottom - top) * 0.72] as [number, number]);
  smoothPath(ctx, pace);
  ctx.strokeStyle = P.amber;
  ctx.lineWidth = 3;
  ctx.stroke();
  drawPill(ctx, P, highContrast, 'ACTIVITY ↻', x + w - 218, y + 20, 40);
}

function drawCommuteAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const mapW = w * 0.7;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const bw = 62 + (col % 2) * 16, bh = 34 + (row % 2) * 12;
      roundRectPath(ctx, x + 24 + col * 92, y + 22 + row * 60, bw, bh, 8);
      ctx.fillStyle = highContrast ? rgba(P.text, 0.06) : P.cellBg;
      ctx.fill();
      ctx.strokeStyle = P.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  const route = [[x + 56, y + h - 48], [x + 158, y + 174], [x + 278, y + 206], [x + 390, y + 104], [x + 526, y + 142]];
  smoothPath(ctx, route);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.stroke();
  route.forEach(([px, py], i) => {
    ctx.beginPath();
    ctx.arc(px, py, i === 2 ? 13 : 8, 0, Math.PI * 2);
    ctx.fillStyle = i === 2 ? P.amber : P.panel;
    ctx.fill();
    ctx.strokeStyle = i === 2 ? P.amber : P.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
  });
  const bx = x + mapW + 34;
  ctx.fillStyle = P.text;
  ctx.font = `700 18px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText('WEEKLY LOG', bx, y + 42);
  const bars = [0.42, 0.7, 0.54, 0.88, 0.64, 0.76, 0.48];
  bars.forEach((v, i) => {
    const bh = v * 150;
    roundRectPath(ctx, bx + i * 30, y + 218 - bh, 18, bh, 6);
    ctx.fillStyle = i === 3 ? P.amber : P.accent;
    ctx.fill();
  });
  drawPill(ctx, P, highContrast, 'PAUSE / RESUME', bx, y + 238, 34);
}

function drawFamilyAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y, w, h, P, highContrast);
  const nodes = [[x + 176, y + 184, 'A'], [x + 442, y + 92, 'B'], [x + 706, y + 178, 'C']] as const;
  nodes.forEach(([px, py], i) => {
    if (i) {
      ctx.beginPath();
      ctx.arc(x + 442, y + 152, i === 1 ? 112 : 224, 0.2, 2.7);
      ctx.strokeStyle = rgba(P.accent, 0.24);
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });
  nodes.forEach(([px, py, label], i) => drawAudienceNode(ctx, P, px, py, label, i === 1 ? P.amber : P.accent));
  roundRectPath(ctx, x + 352, y + 126, 180, 64, 18);
  ctx.fillStyle = P.panel;
  ctx.fill();
  ctx.strokeStyle = P.accentLine;
  ctx.stroke();
  ctx.fillStyle = P.text;
  ctx.font = `700 20px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('1 / 2 / 4 / 8h', x + 442, y + 166);
}

function drawOverlandAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y + 12, 492, h - 24, P, highContrast);
  smoothPath(ctx, [[x + 50, y + 218], [x + 144, y + 148], [x + 254, y + 186], [x + 422, y + 72]]);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 5;
  ctx.stroke();
  drawPill(ctx, P, highContrast, 'CACHED ✓', x + 26, y + 26, 40);
  const px = x + 606;
  roundRectPath(ctx, px, y + 8, 156, 248, 26);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px + 78, y + 126, 52, 0, Math.PI * 2);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  drawLock(ctx, px + 60, y + 104, 36, P.accent);
  ctx.fillStyle = P.muted;
  ctx.font = `600 14px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('OLED LOCK', px + 78, y + 214);
  ctx.fillStyle = P.amber;
  ctx.beginPath();
  ctx.moveTo(x + 526, y + 208);
  ctx.lineTo(x + 558, y + 160);
  ctx.lineTo(x + 590, y + 160);
  ctx.lineTo(x + 612, y + 208);
  ctx.closePath();
  ctx.fill();
  [548, 582].forEach((wx) => {
    ctx.beginPath();
    ctx.arc(x + wx, y + 212, 12, 0, Math.PI * 2);
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.strokeStyle = P.amber;
    ctx.stroke();
  });
}

function drawEventAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y, 570, h, P, highContrast);
  const nodes = [[x + 116, y + 196, 'L'], [x + 288, y + 92, '1'], [x + 452, y + 178, '2']] as const;
  smoothPath(ctx, nodes.map(([px, py]) => [px, py]));
  ctx.strokeStyle = rgba(P.accent, 0.3);
  ctx.lineWidth = 3;
  ctx.setLineDash([8, 9]);
  ctx.stroke();
  ctx.setLineDash([]);
  nodes.forEach(([px, py, label], i) => drawAudienceNode(ctx, P, px, py, label, i ? P.accent : P.amber, 24));
  const cx = x + 650;
  drawMiniFile(ctx, P, highContrast, cx, y + 22, 176, 104, '02:00:00');
  ctx.fillStyle = P.text;
  ctx.font = `700 18px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('ROOM LIMIT', cx, y + 158);
  ['LEAD', 'MEMBER 01', 'MEMBER 02'].forEach((label, i) => {
    const ry = y + 182 + i * 28;
    ctx.beginPath();
    ctx.arc(cx + 7, ry - 6, 5, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? P.amber : P.accent;
    ctx.fill();
    ctx.fillStyle = P.muted;
    ctx.font = `600 14px ${MONO}`;
    ctx.fillText(label, cx + 22, ry);
  });
}

function drawFieldAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y, w, h, P, highContrast);
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.ellipse(x + 246, y + 148, 80 + i * 38, 42 + i * 20, -0.28, 0, Math.PI * 2);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const pts = [[x + 92, y + 218], [x + 206, y + 152], [x + 344, y + 178], [x + 492, y + 78]];
  smoothPath(ctx, pts);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4;
  ctx.stroke();
  pts.slice(0, 3).forEach(([px, py], i) => {
    ctx.beginPath();
    ctx.arc(px, py, 12, 0, Math.PI * 2);
    ctx.fillStyle = i === 1 ? P.amber : P.accent;
    ctx.fill();
  });
  drawSyntheticPhoto(ctx, x + 570, y + 24, 150, 104, P, highContrast);
  drawMiniFile(ctx, P, highContrast, x + 566, y + 148, 226, 104, 'FIELD.gpx');
  drawPill(ctx, P, highContrast, 'PHOTO + NOTE', x + 570, y + 238, 36);
}

function drawDataAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMiniFile(ctx, P, highContrast, x + 52, y + 36, 214, 154, 'tracks.zip');
  drawMiniFile(ctx, P, highContrast, x + 86, y + 66, 214, 154, 'route.xml');
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x + 336, y + 140);
  ctx.lineTo(x + 492, y + 140);
  ctx.lineTo(x + 472, y + 120);
  ctx.moveTo(x + 492, y + 140);
  ctx.lineTo(x + 472, y + 160);
  ctx.stroke();
  const labels = ['GPX', 'GEOJSON', 'KML'];
  labels.forEach((label, i) => {
    const fy = y + 30 + i * 78;
    roundRectPath(ctx, x + 542, fy, 226, 58, 16);
    ctx.fillStyle = highContrast ? P.accent : P.accentSoft;
    ctx.fill();
    ctx.fillStyle = highContrast ? P.panel : P.accent;
    ctx.font = `700 20px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, x + 655, fy + 37);
  });
  drawPill(ctx, P, highContrast, 'WGS-84', x + 338, y + 204, 40);
}

function drawYearlyAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const gx = x + 20, gy = y + 22, cellW = 70, cellH = 48;
  for (let i = 0; i < 12; i++) {
    const cx = gx + (i % 4) * (cellW + 12);
    const cy = gy + Math.floor(i / 4) * (cellH + 14);
    roundRectPath(ctx, cx, cy, cellW, cellH, 12);
    ctx.fillStyle = i === 7 ? P.amber : (highContrast ? P.accent : P.accentSoft);
    ctx.fill();
    ctx.fillStyle = i === 7 || highContrast ? P.panel : P.accent;
    ctx.font = `700 17px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1).padStart(2, '0'), cx + cellW / 2, cy + 31);
  }
  const vx = x + 392;
  roundRectPath(ctx, vx, y + 22, 196, 226, 18);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.accentLine;
  ctx.lineWidth = 2;
  ctx.stroke();
  drawSyntheticPhoto(ctx, vx + 16, y + 38, 164, 126, P, highContrast);
  ctx.fillStyle = P.text;
  ctx.font = `700 16px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('YEARLY IMAGE', vx + 98, y + 204);
  const px = x + 628;
  roundRectPath(ctx, px, y + 22, 196, 226, 18);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.amber;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px + 98, y + 112, 38, 0, Math.PI * 2);
  ctx.fillStyle = rgba(P.amber, 0.16);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px + 88, y + 94);
  ctx.lineTo(px + 116, y + 112);
  ctx.lineTo(px + 88, y + 130);
  ctx.closePath();
  ctx.fillStyle = P.amber;
  ctx.fill();
  ctx.fillStyle = P.text;
  ctx.font = `700 16px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('9s VIDEO', px + 98, y + 204);
}

function drawOledAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const px = x + 330, py = y + 6;
  roundRectPath(ctx, px, py, 220, 264, 32);
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = 2;
  ctx.stroke();
  [0, 1].forEach((side) => {
    const cx = side ? px + 244 : px - 24;
    ctx.beginPath();
    ctx.arc(cx, y + 126, 46, side ? -1.2 : 1.9, side ? 1.2 : 4.4);
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.fillStyle = P.muted;
    ctx.font = `600 13px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(side ? 'R HOLD' : 'L HOLD', cx, y + 196);
  });
  ctx.beginPath();
  ctx.arc(px + 110, y + 112, 52, 0, Math.PI * 2);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  drawLock(ctx, px + 86, y + 88, 48, P.accent);
  const sx = px + 36, sy = y + 214;
  ctx.strokeStyle = P.muted;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(sx + 148, sy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(sx + 118, sy, 14, 0, Math.PI * 2);
  ctx.fillStyle = P.amber;
  ctx.fill();
  ctx.fillStyle = P.muted;
  ctx.font = `600 13px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText('120px', sx + 74, sy + 32);
  drawPill(ctx, P, highContrast, 'OLED BLACK', x + 620, y + 56, 40);
  drawPill(ctx, P, highContrast, 'LONG HOLD', x + 620, y + 116, 40);
  drawPill(ctx, P, highContrast, 'CAMERA', x + 620, y + 176, 40);
}

function drawWalkAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  drawMapTexture(ctx, x, y, w, h, P, highContrast);
  const loop = [[x + 136, y + 202], [x + 236, y + 82], [x + 430, y + 64], [x + 590, y + 148], [x + 510, y + 226], [x + 288, y + 216], [x + 136, y + 202]];
  smoothPath(ctx, loop);
  ctx.strokeStyle = rgba(P.accent, 0.18);
  ctx.lineWidth = 18;
  ctx.lineCap = 'round';
  ctx.stroke();
  smoothPath(ctx, loop);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 5;
  ctx.stroke();
  [[x + 236, y + 82], [x + 510, y + 226]].forEach(([px, py], i) => {
    ctx.beginPath();
    ctx.arc(px, py, 25, 0, Math.PI * 2);
    ctx.fillStyle = i ? P.amber : P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
    ctx.font = `800 18px ${SPORT_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(i ? '02' : '01', px, py + 6);
  });
  drawSyntheticPhoto(ctx, x + 646, y + 28, 152, 104, P, highContrast);
  drawPill(ctx, P, highContrast, '# MORNING', x + 624, y + 166, 38);
  drawPill(ctx, P, highContrast, '# FAVORITE', x + 624, y + 218, 38);
}

function drawSiteAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const route = [[x + 92, y + 222], [x + 214, y + 154], [x + 342, y + 190], [x + 486, y + 82]];
  smoothPath(ctx, route);
  ctx.strokeStyle = rgba(P.accent, 0.24);
  ctx.lineWidth = 4;
  ctx.setLineDash([7, 9]);
  ctx.stroke();
  ctx.setLineDash([]);
  route.forEach(([px, py], i) => {
    roundRectPath(ctx, px - 22, py - 22, 44, 44, 12);
    ctx.fillStyle = i === 3 ? P.amber : P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = i === 3 ? P.amber : P.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = i === 3 ? P.panel : P.accent;
    ctx.font = `800 18px ${SPORT_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), px, py + 6);
  });
  const cx = x + 566;
  drawSyntheticPhoto(ctx, cx, y + 22, 236, 132, P, highContrast);
  roundRectPath(ctx, cx, y + 174, 236, 78, 16);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.grid;
  ctx.stroke();
  ctx.fillStyle = P.text;
  ctx.font = `700 17px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText('ACTIVITY', cx + 18, y + 204);
  ctx.fillStyle = P.accent;
  ctx.font = `700 18px ${MONO}`;
  ctx.fillText('FIELD VISIT ↻', cx + 18, y + 232);
}

function drawLovedAudience(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  const bx = x + 82, by = y + 20, bw = 574, bh = 236;
  roundRectPath(ctx, bx, by, bw, bh, 20);
  ctx.fillStyle = highContrast ? P.panel : P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.accentLine;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = P.grid;
  ctx.fillRect(bx + 2, by + 2, bw - 4, 38);
  [P.accent, P.amber, P.muted].forEach((color, i) => {
    ctx.beginPath();
    ctx.arc(bx + 24 + i * 20, by + 21, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.fillStyle = P.text;
  ctx.font = `700 18px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText('trip.html', bx + 96, by + 28);
  drawSyntheticPhoto(ctx, bx + 22, by + 58, 190, 142, P, highContrast);
  ctx.fillStyle = P.text;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText('A JOURNEY TO SHARE', bx + 238, by + 82);
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i === 0 ? P.accent : P.grid;
    ctx.fillRect(bx + 238, by + 108 + i * 20, 270 - (i % 2) * 56, 5);
  }
  const actions = ['SHARE', 'SAVE', 'COPY'];
  actions.forEach((label, i) => {
    const ax = x + 700 + (i % 2) * 84;
    const ay = y + 60 + Math.floor(i / 2) * 98;
    ctx.beginPath();
    ctx.arc(ax, ay, 30, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? P.amber : P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = i === 0 ? P.amber : P.accentLine;
    ctx.stroke();
    ctx.fillStyle = i === 0 ? P.panel : P.accent;
    ctx.font = `800 18px ${SPORT_FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(label[0], ax, ay + 6);
    ctx.fillStyle = P.muted;
    ctx.font = `600 12px ${MONO}`;
    ctx.fillText(label, ax, ay + 52);
  });
}

function drawAudienceArt(ctx: CanvasRenderingContext2D, P, highContrast: boolean, visual: string, x: number, y: number, w: number, h: number) {
  const renderers = {
    privacy: drawPrivacyAudience, crew: drawCrewAudience, creator: drawCreatorAudience,
    crossBorder: drawCrossBorderAudience, frontend: drawFrontendAudience, athlete: drawAthleteAudience,
    commute: drawCommuteAudience, family: drawFamilyAudience, overland: drawOverlandAudience,
    event: drawEventAudience, field: drawFieldAudience, data: drawDataAudience,
    yearly: drawYearlyAudience, oled: drawOledAudience, walk: drawWalkAudience,
    site: drawSiteAudience, loved: drawLovedAudience
  };
  renderers[visual](ctx, P, highContrast, x, y, w, h);
}

function drawAudienceCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean, variant: number) {
  const copy = audienceCopy(variant);
  const x = M, y = 566, w = W - M * 2, h = 500;
  drawPanel(ctx, P, highContrast, x, y, w, h);
  drawCardHeading(ctx, P, highContrast, x, y, w, copy.label, t('promo.audienceTag', { n: variant - 7 }));
  const ax = x + 28, ay = y + 82, aw = w - 56, ah = 284;
  ctx.save();
  roundRectPath(ctx, ax, ay, aw, ah, INNER_RADIUS);
  ctx.clip();
  ctx.fillStyle = highContrast ? rgba(P.accent, 0.035) : P.cellBg;
  ctx.fillRect(ax, ay, aw, ah);
  drawAudienceArt(ctx, P, highContrast, audienceAt(variant)!.visual, ax, ay, aw, ah);
  ctx.restore();
  drawAudienceFeatures(ctx, P, highContrast, copy.features, x + 38, y + 402, w - 76);
}

export function promoVariantSlug(variant: number): string {
  const v = normalizeVariant(variant);
  return audienceAt(v)?.id || String(v + 1);
}

export function promoCaption(variant = 0): string {
  const v = normalizeVariant(variant);
  const audience = audienceAt(v);
  const key = audience ? `promo.audience.${audience.key}.caption` : (v === 0 ? 'promo.caption' : `promo.caption${v + 1}`);
  return t(key, { url: SITE_URL });
}

export async function generatePromo(variant = pickPromoVariant()): Promise<{ blob: Blob; filename: string; variant: number; caption: string }> {
  await loadBrandFonts();
  const P = canvasPalette();
  const theme = effectiveTheme();
  const highContrast = theme === 'contrast';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const v = normalizeVariant(variant);

  drawBackground(ctx, P, highContrast, theme);
  drawHeader(ctx, P, highContrast);

  const audience = audienceAt(v);
  const audienceText = audience ? audienceCopy(v) : null;
  const heroKeys = audience ? null : [
    ['eyebrow', 'headline1', 'headline2', 'sub1', 'sub2'],
    ['yEyebrow', 'yHeadline1', 'yHeadline2', 'ySub1', 'ySub2'],
    ['mEyebrow', 'mHeadline1', 'mHeadline2', 'mSub1', 'mSub2'],
    ['aEyebrow', 'aHeadline1', 'aHeadline2', 'aSub1', 'aSub2'],
    ['rEyebrow', 'rHeadline1', 'rHeadline2', 'rSub1', 'rSub2'],
    ['gEyebrow', 'gHeadline1', 'gHeadline2', 'gSub1', 'gSub2'],
    ['cEyebrow', 'cHeadline1', 'cHeadline2', 'cSub1', 'cSub2'],
    ['pEyebrow', 'pHeadline1', 'pHeadline2', 'pSub1', 'pSub2']
  ][v].map((key) => t(`promo.${key}`));
  drawHeroCopy(ctx, P, highContrast, audienceText ? {
    eyebrow: audienceText.eyebrow, l1: audienceText.l1, l2: audienceText.l2,
    s1: audienceText.s1, s2: audienceText.s2
  } : {
    eyebrow: heroKeys![0], l1: heroKeys![1], l2: heroKeys![2], s1: heroKeys![3], s2: heroKeys![4]
  });

  if (audienceText) {
    drawAudienceCard(ctx, P, highContrast, v);
  } else {
    const cards = [drawRouteCard, drawYearCard, drawMeetCard, drawActivityCard, drawRecapCard, drawRecoveryCard, drawCityCard, drawPrivacyCard];
    cards[v](ctx, P, highContrast);
    if (v === 0) drawFeatures(ctx, P, highContrast);
  }
  drawFooter(ctx, P, highContrast, audienceText?.cta);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { blob, filename: `roametch-promo-${promoVariantSlug(v)}-${Date.now()}.png`, variant: v, caption: promoCaption(v) };
}
