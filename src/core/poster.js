// Poster composer: 1080×1920 / 1080×1080. Basemap is painted at native poster
// resolution via mapPaint (crisp, no screen-snapshot upscale); automatically
// degrades to a pure-vector poster when tiles fail / offline / vector-only.
import { applyPrivacy } from './privacy.js';
import { computeStats } from './stats.js';
import { fmtDistance, fmtDuration } from './geo.js';
import { get } from './settings.js';
import { prepareMap, paintTrack } from './mapPaint.js';
import { computeTripScore, drawScoreBadge, fitText, roundRectPath } from './tripScore.js';
import { canvasPalette } from './palette.js';
import { t } from './i18n.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';

function drawProfile(ctx, stats, x, y, w, h, P) {
  const alts = stats.series.alt;
  const ds = stats.series.d;
  if (!alts.some((a) => a != null) || ds.length < 2) return;
  const valid = alts.map((a, i) => [ds[i], a]).filter(([, a]) => a != null);
  if (valid.length < 2) return;
  const minA = Math.min(...valid.map((v) => v[1]));
  const maxA = Math.max(...valid.map((v) => v[1]));
  const maxD = ds[ds.length - 1] || 1;
  const span = Math.max(1, maxA - minA);
  ctx.beginPath();
  valid.forEach(([d, a], i) => {
    const px = x + (d / maxD) * w;
    const py = y + h - ((a - minA) / span) * (h - 8) - 4;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  });
  ctx.strokeStyle = P.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
  ctx.fillStyle = P.accentSoft;
  ctx.fill();
  ctx.fillStyle = P.muted;
  ctx.font = `20px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(maxA)}m`, x + 4, y + 18);
  ctx.fillText(`${Math.round(minA)}m`, x + 4, y + h - 6);
}

function drawInfoPanel(ctx, full, stats, x, y, w, h, { basemapLabel, score }, P) {
  const units = get('units');
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 52px ${FONT}`;
  const name = (full.trip.name || t('record.newTripName')).slice(0, 24);
  ctx.fillText(fitText(ctx, name, w - (score ? 190 : 0)), x, y + 56);
  ctx.fillStyle = P.muted;
  ctx.font = `26px ${FONT}`;
  const dateStr = new Date(full.trip.createdAt).toLocaleDateString();
  ctx.fillText(`${dateStr} · ${t(`record.activities.${full.trip.activity}`)}`, x, y + 96);
  if (score) {
    drawScoreBadge(ctx, score, x + w - 168, y + 8, P);
    ctx.fillStyle = P.muted;
    ctx.font = `22px ${FONT}`;
    ctx.fillText(fitText(ctx, score.comment, w), x, y + 132);
  }

  const d = fmtDistance(stats.distance, units);
  const cells = [
    [`${d.v}`, d.u, t('panel.distance')],
    [fmtDuration(stats.duration, { compact: true }), '', t('panel.duration')],
    [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')]
  ];
  const cw = w / 3;
  cells.forEach(([v, u, k], i) => {
    const cx = x + i * cw;
    ctx.fillStyle = P.accent;
    ctx.font = `800 54px ${MONO}`;
    ctx.fillText(v, cx, y + 196);
    const vw = ctx.measureText(v).width;
    ctx.fillStyle = P.muted;
    ctx.font = `24px ${FONT}`;
    if (u) ctx.fillText(u, cx + vw + 8, y + 196);
    ctx.fillText(k, cx, y + 232);
  });

  drawProfile(ctx, stats, x, y + 260, w, Math.max(120, h - 360), P);

  ctx.fillStyle = P.faint;
  ctx.font = `20px ${FONT}`;
  ctx.fillText(`${t('app.name')} · ${basemapLabel || 'vector'} · WGS-84`, x, y + h - 44);
  ctx.font = `17px ${FONT}`;
  ctx.fillText(t('analysis.disclaimer').slice(0, 60), x, y + h - 14);
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Fade the bottom of the map into the panel colour so the seam reads as one
// continuous surface instead of a hard rectangle edge.
function blendSeam(ctx, y0, y1, w, P) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, rgba(P.panel, 0));
  g.addColorStop(1, rgba(P.panel, 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, y0, w, y1 - y0);
}

function drawStatCard(ctx, x, y, w, h, v, u, label, P) {
  roundRectPath(ctx, x, y, w, h, 18);
  ctx.fillStyle = P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = `800 44px ${MONO}`;
  ctx.fillText(v, x + 22, y + 50);
  const vw = ctx.measureText(v).width;
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  if (u) ctx.fillText(u, x + 22 + vw + 8, y + 50);
  ctx.fillText(label, x + 22, y + 82);
}

function drawSquarePanel(ctx, full, stats, m, score, W, H, mapH, P) {
  const units = get('units');
  const py = mapH;
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, py, W, H - py);
  // thin gradient seam echoing the track colours
  const seam = ctx.createLinearGradient(0, 0, W, 0);
  const lut = P.lut;
  seam.addColorStop(0, `rgb(${lut[0].join(',')})`);
  seam.addColorStop(0.5, `rgb(${lut[1].join(',')})`);
  seam.addColorStop(1, `rgb(${lut[2].join(',')})`);
  ctx.fillStyle = seam;
  ctx.fillRect(0, py, W, 5);

  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.fillRect(60, py + 34, 64, 6);
  ctx.fillStyle = P.text;
  ctx.font = `800 46px ${FONT}`;
  const name = (full.trip.name || t('record.newTripName')).slice(0, 24);
  ctx.fillText(fitText(ctx, name, W - 120 - 190), 60, py + 92);
  ctx.fillStyle = P.muted;
  ctx.font = `24px ${FONT}`;
  const dateStr = new Date(full.trip.createdAt).toLocaleDateString();
  ctx.fillText(`${dateStr} · ${t(`record.activities.${full.trip.activity}`)}`, 60, py + 128);
  drawScoreBadge(ctx, score, W - 60 - 168, py + 40, P);
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(fitText(ctx, score.comment, W - 120), 60, py + 164);

  const d = fmtDistance(stats.distance, units);
  const cells = [
    [d.v, d.u, t('panel.distance')],
    [fmtDuration(stats.duration, { compact: true }), '', t('panel.duration')],
    [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')]
  ];
  const gap = 16, cw = (W - 120 - gap * 2) / 3, ch = 104, cy = py + 190;
  cells.forEach(([v, u, k], i) => drawStatCard(ctx, 60 + i * (cw + gap), cy, cw, ch, v, u, k, P));

  drawProfile(ctx, stats, 60, cy + ch + 24, W - 120, 100, P);

  ctx.fillStyle = P.faint;
  ctx.font = `19px ${FONT}`;
  ctx.fillText(`${t('app.name')} · ${m.label || 'vector'} · WGS-84`, 60, H - 24);
}

/**
 * @returns {Promise<{canvas, blob, usedVectorFallback:boolean}>}
 */
export async function generatePoster(full, {
  size = 'vertical',
  privacy = { radius: 300, hideSensitive: true },
  vectorOnly = false,
  basemapId = '',
  onProgress
} = {}) {
  const P = canvasPalette();
  const cropped = applyPrivacy(full, privacy);
  const stats = computeStats(cropped.segments, { ascentThreshold: get('ascentThreshold') });
  const score = computeTripScore(stats, full.trip.activity);
  const W = 1080;
  const H = size === 'square' ? 1080 : 1920;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (size === 'square') {
    const mapH = 600;
    const m = await prepareMap({
      w: W, h: mapH, pad: 80, segments: cropped.segments, waypoints: cropped.waypoints,
      basemapId, vectorOnly, onProgress
    });
    ctx.drawImage(m.bg, 0, 0);
    paintTrack(ctx, m.fit, m.segments, m.waypoints, { lineWidth: 7, dotRadius: 13 });
    blendSeam(ctx, mapH - 170, mapH, W, P);
    drawSquarePanel(ctx, full, stats, m, score, W, H, mapH, P);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return { canvas, blob, usedVectorFallback: m.vector };
  }

  const mapH = 1150;
  const m = await prepareMap({
    w: W, h: mapH, pad: 90, segments: cropped.segments, waypoints: cropped.waypoints,
    basemapId, vectorOnly, onProgress
  });
  ctx.drawImage(m.bg, 0, 0);
  paintTrack(ctx, m.fit, m.segments, m.waypoints);
  blendSeam(ctx, mapH - 150, mapH, W, P);
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, mapH, W, H - mapH);
  ctx.fillStyle = P.accent;
  ctx.fillRect(60, mapH + 36, 64, 6);
  drawInfoPanel(ctx, full, stats, 60, mapH + 60, W - 120, H - mapH - 100, { basemapLabel: m.label, score }, P);

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { canvas, blob, usedVectorFallback: m.vector };
}