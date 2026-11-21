// Generic share promo (1080×1350): brand, product highlights, live-style route
// card and QR. Vector-only so it works offline and never contains trip data.
import { canvasPalette } from './palette';
import { drawBrandMark, drawQr, loadBrandFonts, SITE_URL, SPORT_FONT } from './brand';
import { fitText, roundRectPath } from './tripScore';
import { t } from './i18n';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const W = 1080;
const H = 1350;
const M = 72;

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function headlineSize(ctx: CanvasRenderingContext2D, lines: string[], maxW: number, start = 88) {
  for (let size = start; size >= 60; size -= 2) {
    ctx.font = `800 ${size}px ${FONT}`;
    if (lines.every((line) => ctx.measureText(line).width <= maxW)) return size;
  }
  return 60;
}

function drawBackground(ctx: CanvasRenderingContext2D, P) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, P.panel);
  g.addColorStop(0.55, P.vectorBg);
  g.addColorStop(1, P.panel);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const glow = (cx: number, cy: number, r: number, color: string, a: number) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, rgba(color, a));
    rg.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  const dark = P.panel === '#000000';
  glow(W * 0.88, 110, 560, P.accent, dark ? 0.17 : 0.1);
  glow(W * 0.06, H * 0.93, 420, P.amber, dark ? 0.08 : 0.06);

  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 120) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, P) {
  drawBrandMark(ctx, M, 64, 64);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.text;
  ctx.font = `800 38px ${FONT}`;
  ctx.fillText(t('app.name'), M + 84, 101);
  ctx.fillStyle = P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(t('app.tagline'), M + 85, 130);

  const pill = t('promo.pill');
  ctx.font = `600 21px ${FONT}`;
  const pw = ctx.measureText(pill).width + 40;
  roundRectPath(ctx, W - M - pw, 78, pw, 42, 21);
  ctx.fillStyle = P.badgeBg;
  ctx.fill();
  ctx.strokeStyle = P.badgeEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = P.accent;
  ctx.fillText(pill, W - M - pw + 20, 105);
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

function drawMapTexture(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, P) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  for (let gx = x + 46; gx < x + w; gx += 66) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.stroke();
  }
  for (let gy = y + 28; gy < y + h; gy += 54) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  const contour = (cx: number, cy: number, rx: number, ry: number, rot: number) => {
    for (const k of [1, 0.68, 0.38]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * k, ry * k, rot, 0, Math.PI * 2);
      ctx.stroke();
    }
  };
  contour(x + w * 0.76, y + h * 0.34, 190, 92, -0.28);
  contour(x + w * 0.24, y + h * 0.14, 150, 70, 0.34);
  ctx.restore();
}

function drawRouteCard(ctx: CanvasRenderingContext2D, P) {
  const x = M;
  const y = 572;
  const w = W - M * 2;
  const h = 400;

  roundRectPath(ctx, x, y, w, h, 30);
  ctx.fillStyle = P.panel;
  ctx.fill();
  ctx.fillStyle = P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  drawMapTexture(ctx, x + 18, y + 62, w - 36, h - 118, P);

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
  ctx.strokeStyle = rgba(P.accent, 0.2);
  ctx.lineWidth = 20;
  ctx.stroke();
  smoothPath(ctx, pts);
  ctx.strokeStyle = P.trackCasing;
  ctx.lineWidth = 9;
  ctx.stroke();
  smoothPath(ctx, pts);
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 4.5;
  ctx.stroke();
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
  const hx = x + 36;
  const hy = y + 46;
  ctx.beginPath();
  ctx.arc(hx, hy - 7, 5, 0, Math.PI * 2);
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
  ctx.fillStyle = P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(`1,284 ${t('panel.points')}`, x + w - 36, hy);
  ctx.textAlign = 'left';

  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 36, y + 318);
  ctx.lineTo(x + w - 36, y + 318);
  ctx.stroke();

  const stats = [
    ['12.8', 'km', t('panel.distance')],
    ['486', 'm', t('panel.ascent')],
    ['2:58', '', t('panel.duration')]
  ];
  stats.forEach(([v, u, k], i) => {
    const sx = x + 36 + i * 300;
    ctx.fillStyle = P.text;
    ctx.font = `800 36px ${SPORT_FONT}`;
    ctx.fillText(v, sx, y + 358);
    const vw = ctx.measureText(v).width;
    if (u) {
      ctx.fillStyle = P.muted;
      ctx.font = `600 20px ${FONT}`;
      ctx.fillText(u, sx + vw + 7, y + 356);
    }
    ctx.fillStyle = P.muted;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(k, sx, y + 384);
  });
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
  } else if (kind === 'share') {
    circle(6, 12, 2.6);
    circle(17, 5.5, 2.6);
    circle(17, 18.5, 2.6);
    ctx.beginPath();
    ctx.moveTo(8.4, 10.8);
    ctx.lineTo(14.6, 7.2);
    ctx.moveTo(8.4, 13.2);
    ctx.lineTo(14.6, 16.8);
    ctx.stroke();
  } else {
    ctx.stroke(new Path2D('m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15'));
  }
  ctx.restore();
}

function drawFeatures(ctx: CanvasRenderingContext2D, P) {
  const features = [
    ['shield', t('promo.f1t'), t('promo.f1d')],
    ['meet', t('promo.f2t'), t('promo.f2d')],
    ['share', t('promo.f3t'), t('promo.f3d')],
    ['map', t('promo.f4t'), t('promo.f4d')]
  ];
  const colW = (W - M * 2 - 36) / 2;
  features.forEach(([kind, title, desc], i) => {
    const fx = M + (i % 2) * (colW + 36);
    const fy = 1002 + Math.floor(i / 2) * 94;
    roundRectPath(ctx, fx, fy, 46, 46, 14);
    ctx.fillStyle = P.accentSoft;
    ctx.fill();
    ctx.strokeStyle = P.accentLine;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    featureGlyph(ctx, kind, fx + 11, fy + 11, 24, P.accent);

    ctx.textAlign = 'left';
    ctx.fillStyle = P.text;
    ctx.font = `700 25px ${FONT}`;
    ctx.fillText(fitText(ctx, title, colW - 62), fx + 62, fy + 20);
    ctx.fillStyle = P.muted;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(fitText(ctx, desc, colW - 62), fx + 62, fy + 48);
  });
}

function drawFooter(ctx: CanvasRenderingContext2D, P) {
  const g = ctx.createLinearGradient(M, 0, W - M, 0);
  g.addColorStop(0, rgba(P.accent, 0.55));
  g.addColorStop(1, rgba(P.accent, 0));
  ctx.fillStyle = g;
  ctx.fillRect(M, 1200, W - M * 2, 1.5);

  drawQr(ctx, SITE_URL, M, 1206, 120);

  const tx = M + 142;
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText(t('promo.cta'), tx, 1246);
  ctx.fillStyle = P.accent;
  ctx.font = `600 23px ${SPORT_FONT}`;
  ctx.fillText(SITE_URL, tx, 1284);
  ctx.fillStyle = P.muted;
  ctx.font = `500 19px ${FONT}`;
  ctx.fillText(t('promo.footer'), tx, 1316);
}

export function promoCaption(): string {
  return t('promo.caption', { url: SITE_URL });
}

export async function generatePromo(): Promise<{ blob: Blob; filename: string }> {
  await loadBrandFonts();
  const P = canvasPalette();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');

  drawBackground(ctx, P);
  drawHeader(ctx, P);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.accent;
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText(t('promo.eyebrow'), M, 220);

  const head1 = t('promo.headline1');
  const head2 = t('promo.headline2');
  const headPx = headlineSize(ctx, [head1, head2], W - M * 2);
  ctx.fillStyle = P.text;
  ctx.font = `800 ${headPx}px ${FONT}`;
  ctx.fillText(head1, M, 314);
  ctx.fillStyle = P.accent;
  ctx.fillText(head2, M, 410);
  const hw = ctx.measureText(head2).width;
  ctx.beginPath();
  ctx.arc(M + hw + 22, 385, 9, 0, Math.PI * 2);
  ctx.fillStyle = P.amber;
  ctx.fill();

  ctx.fillStyle = P.muted;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(t('promo.sub1'), M, 476);
  ctx.fillStyle = P.faint;
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(t('promo.sub2'), M, 516);

  drawRouteCard(ctx, P);
  drawFeatures(ctx, P);
  drawFooter(ctx, P);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { blob, filename: `trackmint-promo-${Date.now()}.png` };
}
