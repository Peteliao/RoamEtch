// Generic share promo (1080×1350): brand, product highlights, live-style route
// card and QR. Vector-only so it works offline and never contains trip data.
import { canvasPalette } from './palette';
import { drawBrandMark, drawQr, loadBrandFonts, SITE_URL, SPORT_FONT } from './brand';
import { fitText, roundRectPath } from './tripScore';
import { t } from './i18n';
import { effectiveTheme } from './theme';
import { APP_VERSION } from './version';

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

const VARIANT_COUNT = 3;
let lastVariant = -1;

export function pickPromoVariant(random = Math.random) {
  const pool = [];
  for (let i = 0; i < VARIANT_COUNT; i++) if (i !== lastVariant) pool.push(i);
  const next = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  lastVariant = next;
  return next;
}

function drawHeroCopy(ctx: CanvasRenderingContext2D, P, highContrast: boolean, copy: { eyebrow: string; l1: string; l2: string; s1: string; s2?: string }) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.accent;
  ctx.font = `700 20px ${FONT}`;
  ctx.fillText(copy.eyebrow, M, 220);

  const headPx = headlineSize(ctx, [copy.l1, copy.l2], W - M * 2);
  ctx.fillStyle = P.text;
  ctx.font = `800 ${headPx}px ${FONT}`;
  ctx.fillText(copy.l1, M, 314);
  const hw = ctx.measureText(copy.l2).width;
  if (highContrast) {
    roundRectPath(ctx, M - 18, 332, hw + 36, 108, 4);
    ctx.fillStyle = P.accent;
    ctx.fill();
    ctx.fillStyle = P.panel;
    ctx.fillText(copy.l2, M, 410);
    ctx.beginPath();
    ctx.arc(M + hw + 40, 385, 9, 0, Math.PI * 2);
    ctx.fillStyle = P.amber;
    ctx.fill();
  } else {
    ctx.fillStyle = P.accent;
    ctx.fillText(copy.l2, M, 410);
    ctx.beginPath();
    ctx.arc(M + hw + 22, 385, 9, 0, Math.PI * 2);
    ctx.fillStyle = P.amber;
    ctx.fill();
  }

  ctx.fillStyle = P.muted;
  ctx.font = `500 28px ${FONT}`;
  ctx.fillText(fitText(ctx, copy.s1, W - M * 2), M, 476);
  if (copy.s2) {
    ctx.fillStyle = P.faint;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillText(fitText(ctx, copy.s2, W - M * 2), M, 516);
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const glow = (cx: number, cy: number, r: number, color: string, a: number) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, rgba(color, a));
    rg.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  };

  if (highContrast) {
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, W, H);
    const wash = ctx.createLinearGradient(0, 0, W, 640);
    wash.addColorStop(0, rgba(P.accent, 0.075));
    wash.addColorStop(0.55, rgba(P.accent, 0.018));
    wash.addColorStop(1, rgba(P.accent, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, 640);
    glow(W * 0.08, H * 0.92, 420, P.amber, 0.045);
    return;
  }

  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, P.panel);
  g.addColorStop(0.55, P.vectorBg);
  g.addColorStop(1, P.panel);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

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

function drawHeader(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  drawBrandMark(ctx, M, 64, 64);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.text;
  ctx.font = `800 38px ${FONT}`;
  ctx.fillText(t('app.name'), M + 84, 101);
  ctx.fillStyle = P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(t('app.tagline'), M + 85, 130);

  const pill = t('promo.pill', { version: APP_VERSION });
  ctx.font = `600 21px ${FONT}`;
  const pw = ctx.measureText(pill).width + 40;
  roundRectPath(ctx, W - M - pw, 78, pw, 42, 21);
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
  const colStep = highContrast ? 88 : 66;
  const rowStep = highContrast ? 72 : 54;
  for (let gx = x + 46; gx < x + w; gx += colStep) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.stroke();
  }
  for (let gy = y + 28; gy < y + h; gy += rowStep) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = highContrast ? rgba(P.text, 0.15) : P.grid;
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

function drawRouteCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  const x = M;
  const y = 572;
  const w = W - M * 2;
  const h = 400;

  if (highContrast) {
    roundRectPath(ctx, x + 10, y + 12, w, h, 30);
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fill();
  }
  roundRectPath(ctx, x, y, w, h, 30);
  ctx.fillStyle = P.panel;
  ctx.fill();
  if (!highContrast) {
    ctx.fillStyle = P.cellBg;
    ctx.fill();
  }
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 3 : 1.5;
  ctx.stroke();

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
  ctx.fillStyle = highContrast ? P.text : P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(`1,284 ${t('panel.points')}`, x + w - 36, hy);
  ctx.textAlign = 'left';

  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 2 : 1;
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
      ctx.fillStyle = highContrast ? P.accent : P.muted;
      ctx.font = `600 20px ${FONT}`;
      ctx.fillText(u, sx + vw + 7, y + 356);
    }
    ctx.fillStyle = highContrast ? P.faint : P.muted;
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
    roundRectPath(ctx, fx, fy, 46, 46, 14);
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
    ctx.font = `700 25px ${FONT}`;
    ctx.fillText(fitText(ctx, title, colW - 62), fx + 62, fy + 20);
    ctx.fillStyle = highContrast ? P.faint : P.muted;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(fitText(ctx, desc, colW - 62), fx + 62, fy + 48);
  });
}

function drawFooter(ctx: CanvasRenderingContext2D, P, highContrast: boolean) {
  if (highContrast) {
    roundRectPath(ctx, M, 1178, W - M * 2, 148, 20);
    ctx.fillStyle = P.accent;
    ctx.fill();

    const qrX = M + 24;
    const qrY = 1192;
    drawQr(ctx, SITE_URL, qrX, qrY, 120);

    const tx = qrX + 142;
    ctx.textAlign = 'left';
    ctx.fillStyle = P.panel;
    ctx.font = `800 30px ${FONT}`;
    ctx.fillText(t('promo.cta'), tx, 1236);
    ctx.fillStyle = P.panel;
    ctx.font = `600 23px ${SPORT_FONT}`;
    ctx.fillText(SITE_URL, tx, 1274);
    ctx.fillStyle = rgba(P.panel, 0.8);
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(t('promo.footer'), tx, 1306);
    return;
  }

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

function drawPanel(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x: number, y: number, w: number, h: number) {
  roundRectPath(ctx, x, y, w, h, 30);
  ctx.fillStyle = P.panel;
  ctx.fill();
  if (!highContrast) {
    ctx.fillStyle = P.cellBg;
    ctx.fill();
  }
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 3 : 1.5;
  roundRectPath(ctx, x, y, w, h, 30);
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
  ctx.fillText('12', x + 34, y + 272);
  ctx.fillStyle = P.muted;
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText(t('promo.yMonthUnit'), x + 41, y + 306);

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
    ctx.fillStyle = i === 7 ? (highContrast ? P.text : P.amber) : P.faint;
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

  const stats = [
    ['128', '', t('trips.sumTrips')],
    ['1,284', 'km', t('analysis.distance')],
    ['16,800', 'm', t('analysis.ascent')],
    ['365', '', t('trips.sumDays')]
  ];
  const cw = (w - 76) / 4;
  stats.forEach(([v, u, k], i) => {
    const sx = x + 38 + i * cw;
    ctx.fillStyle = i === 1 ? P.accent : P.text;
    ctx.font = `800 46px ${SPORT_FONT}`;
    ctx.fillText(v, sx, y + 422);
    const vw = ctx.measureText(v).width;
    if (u) {
      ctx.fillStyle = P.muted;
      ctx.font = `600 20px ${FONT}`;
      ctx.fillText(u, sx + vw + 6, y + 420);
    }
    ctx.fillStyle = P.faint;
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(fitText(ctx, k, cw - 16), sx, y + 456);
  });
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

  const chips = [t('promo.mChip1'), t('promo.mChip2'), t('promo.mChip3')];
  let cx = x + 38;
  const cy = y + 404;
  ctx.font = `600 20px ${FONT}`;
  for (const label of chips) {
    const cw = ctx.measureText(label).width + 44;
    roundRectPath(ctx, cx, cy, cw, 48, 24);
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
    ctx.textAlign = 'center';
    ctx.fillText(label, cx + cw / 2, cy + 32);
    cx += cw + 12;
  }
  ctx.textAlign = 'left';
}

function drawNoteLine(ctx: CanvasRenderingContext2D, P, text: string) {
  ctx.textAlign = 'center';
  ctx.fillStyle = P.muted;
  ctx.font = `500 21px ${FONT}`;
  ctx.fillText(fitText(ctx, text, W - M * 2), W / 2, 1120);
  ctx.textAlign = 'left';
}

export function promoCaption(variant = 0): string {
  const key = variant === 0 ? 'promo.caption' : `promo.caption${variant + 1}`;
  return t(key, { url: SITE_URL });
}

export async function generatePromo(variant = pickPromoVariant()): Promise<{ blob: Blob; filename: string; variant: number; caption: string }> {
  await loadBrandFonts();
  const P = canvasPalette();
  const highContrast = effectiveTheme() === 'contrast';
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const v = Math.max(0, Math.min(VARIANT_COUNT - 1, Math.trunc(variant) || 0));

  drawBackground(ctx, P, highContrast);
  drawHeader(ctx, P, highContrast);

  if (v === 1) {
    drawHeroCopy(ctx, P, highContrast, {
      eyebrow: t('promo.yEyebrow'),
      l1: t('promo.yHeadline1'),
      l2: t('promo.yHeadline2'),
      s1: t('promo.ySub1'),
      s2: t('promo.ySub2')
    });
    drawYearCard(ctx, P, highContrast);
    drawNoteLine(ctx, P, t('promo.yNote'));
  } else if (v === 2) {
    drawHeroCopy(ctx, P, highContrast, {
      eyebrow: t('promo.mEyebrow'),
      l1: t('promo.mHeadline1'),
      l2: t('promo.mHeadline2'),
      s1: t('promo.mSub1'),
      s2: t('promo.mSub2')
    });
    drawMeetCard(ctx, P, highContrast);
    drawNoteLine(ctx, P, t('promo.mNote'));
  } else {
    drawHeroCopy(ctx, P, highContrast, {
      eyebrow: t('promo.eyebrow'),
      l1: t('promo.headline1'),
      l2: t('promo.headline2'),
      s1: t('promo.sub1'),
      s2: t('promo.sub2')
    });
    drawRouteCard(ctx, P, highContrast);
    drawFeatures(ctx, P, highContrast);
  }
  drawFooter(ctx, P, highContrast);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { blob, filename: `trackmint-promo-${v + 1}-${Date.now()}.png`, variant: v, caption: promoCaption(v) };
}
