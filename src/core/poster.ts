// Poster composer: 1080×1920 / 1080×1080. Basemap is painted at native poster
// resolution via mapPaint (crisp, no screen-snapshot upscale); automatically
// degrades to a pure-vector poster when tiles fail / offline / vector-only.
import { applyPrivacy } from './privacy';
import { computeStats } from './stats';
import { fmtDistance, fmtDuration, signalLevel } from './geo';
import { get } from './settings';
import { prepareMap, paintTrack } from './mapPaint';
import { computeTripScore, drawScoreBadge, fitText, roundRectPath } from './tripScore';
import { canvasPalette } from './palette';
import { loadBrandFonts, drawBrandBlock, drawSignalChip, SPORT_FONT } from './brand';
import { t } from './i18n';

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

function drawCaloriesCell(stats) {
  const kcal = stats.calories != null ? `${Math.round(stats.calories)}` : '—';
  return [kcal, stats.calories != null ? 'kcal' : '', t('panel.calories')];
}

function drawInfoPanel(ctx, full, stats, x, y, w, h, { score }, P) {
  const units = get('units');
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 52px ${FONT}`;
  const name = (full.trip.name || t('record.newTripName')).slice(0, 24);
  ctx.fillText(fitText(ctx, name, w - (score ? 190 : 0)), x, y + 56);
  ctx.fillStyle = P.muted;
  ctx.font = `26px ${FONT}`;
  const dateStr = new Date(full.trip.createdAt).toLocaleDateString();
  const dateLine = `${dateStr} · ${t(`record.activities.${full.trip.activity}`)}`;
  ctx.fillText(dateLine, x, y + 96);
  const dw = ctx.measureText(dateLine).width;
  drawSignalChip(ctx, x + dw + 18, y + 96, signalLevel(stats.avgAcc), { on: P.accent, off: P.grid, text: P.muted });
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
    [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')],
    drawCaloriesCell(stats)
  ];
  const cw = w / 4;
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

  const brandY = y + h - 150;
  drawProfile(ctx, stats, x, y + 260, w, Math.max(120, brandY - 30 - (y + 260)), P);
  drawBrandBlock(ctx, x, brandY, 150, P, w - 170);
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

function drawSquarePanel(ctx, full, stats, score, W, H, mapH, P) {
  const units = get('units');
  const py = mapH;
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, py, W, H - py);

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
  const dateLine = `${dateStr} · ${t(`record.activities.${full.trip.activity}`)}`;
  ctx.fillText(dateLine, 60, py + 128);
  const dw = ctx.measureText(dateLine).width;
  drawSignalChip(ctx, 60 + dw + 18, py + 128, signalLevel(stats.avgAcc), { on: P.accent, off: P.grid, text: P.muted });
  drawScoreBadge(ctx, score, W - 60 - 168, py + 40, P);
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(fitText(ctx, score.comment, W - 120), 60, py + 164);

  const d = fmtDistance(stats.distance, units);
  const cells = [
    [d.v, d.u, t('panel.distance')],
    [fmtDuration(stats.duration, { compact: true }), '', t('panel.duration')],
    [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')],
    drawCaloriesCell(stats)
  ];
  const gap = 16, cw = (W - 120 - gap * 3) / 4, ch = 92, cy = py + 186;
  cells.forEach(([v, u, k], i) => drawStatCard(ctx, 60 + i * (cw + gap), cy, cw, ch, v, u, k, P));

  drawBrandBlock(ctx, 60, H - 160, 130, P, W - 120 - 150);
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
}: any = {}): Promise<any> {
  const P = canvasPalette();
  await loadBrandFonts();
  const cropped = applyPrivacy(full, privacy);
  const stats = computeStats(cropped.segments, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  });
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
    ctx.fillStyle = P.accent;
    ctx.fillRect(0, mapH - 8, W, 8);
    drawSquarePanel(ctx, full, stats, score, W, H, mapH, P);
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
  ctx.fillStyle = P.accent;
  ctx.fillRect(0, mapH - 8, W, 8);
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, mapH, W, H - mapH);
  ctx.fillStyle = P.accent;
  ctx.fillRect(60, mapH + 36, 64, 6);
  drawInfoPanel(ctx, full, stats, 60, mapH + 60, W - 120, H - mapH - 100, { score }, P);

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { canvas, blob, usedVectorFallback: m.vector };
}