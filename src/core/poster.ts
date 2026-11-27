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
import { loadBrandFonts, drawBrandBlock, drawQr, drawSignalChip, SITE_URL } from './brand';
import { tripTimeInfo, routePlaceNames } from './shareInfo';
import { t } from './i18n';
import { buildProfile, drawProfileChart } from './profileChart';
import { bridgeTrackGapsForExport } from './gapRepair';
import { normalizeShareStyle, posterLayout, shareFontStack, trackColorValue } from './shareStyle';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';

function designedPalette(P, background) {
  if (background === 'night') {
    return {
      ...P,
      panel: '#0b1220',
      text: '#f4f8fb',
      muted: '#a7b8c4',
      faint: '#718795',
      accent: P.accent || '#2bcda7',
      cellBg: 'rgba(255,255,255,0.055)',
      grid: 'rgba(255,255,255,0.14)',
      endRing: 'rgba(255,255,255,0.92)'
    };
  }
  if (background === 'paper') {
    return {
      ...P,
      panel: '#f4f0e6',
      text: '#1d292d',
      muted: '#59686d',
      faint: '#8a9699',
      accent: '#0f766e',
      accentSoft: 'rgba(15,118,110,0.12)',
      accentLine: '#0f766e',
      amber: '#b45309',
      cellBg: 'rgba(255,255,255,0.55)',
      grid: 'rgba(29,41,45,0.13)',
      endRing: 'rgba(255,255,255,0.94)'
    };
  }
  return P;
}

function design(full, style) {
  return {
    name: (style.title || full.trip.name || t('record.newTripName')).slice(0, 24),
    font: shareFontStack(style.font)
  };
}

function drawProfile(ctx, stats, x, y, w, h, P) {
  const profile = buildProfile(stats, get('units'), 1200);
  drawProfileChart(ctx, profile, { x, y, w, h }, P, {
    altitudeLabel: t('panel.altitude'),
    speedLabel: t('panel.speed')
  });
}

function drawCaloriesCell(stats) {
  const kcal = stats.calories != null ? `${Math.round(stats.calories)}` : '—';
  return [kcal, stats.calories != null ? 'kcal' : '', t('panel.calories')];
}

function drawInfoPanel(ctx, full, stats, x, y, w, h, { score, time, places, dsn, showStats, compact = false }, P) {
  const units = get('units');
  const font = dsn.font;
  const titleSize = compact ? 44 : 52;
  const metaSize = compact ? 21 : 24;
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 ${titleSize}px ${font}`;
  ctx.fillText(fitText(ctx, dsn.name, w - (score ? 190 : 0)), x, y + (compact ? 46 : 56));
  ctx.fillStyle = P.muted;
  ctx.font = `${metaSize}px ${font}`;
  const activity = t(`record.activities.${full.trip.activity}`);
  const dateStr = time?.date || new Date(full.trip.createdAt).toLocaleDateString();
  const dateLine = time
    ? `${dateStr} · ${activity} · ${time.start} → ${time.end}`
    : `${dateStr} · ${activity}`;
  const dateShown = fitText(ctx, dateLine, w - 140);
  ctx.fillText(dateShown, x, y + (compact ? 82 : 96));
  const dw = ctx.measureText(dateShown).width;
  drawSignalChip(ctx, x + dw + 18, y + (compact ? 82 : 96), signalLevel(stats.avgAcc), { on: P.accent, off: P.grid, text: P.muted });
  if (score) {
    drawScoreBadge(ctx, score, x + w - 168, y + 8, P);
    if (!compact) {
      ctx.fillStyle = P.muted;
      ctx.font = `22px ${font}`;
      ctx.fillText(fitText(ctx, score.comment, w), x, y + 132);
    }
  }

  let profileY;
  if (showStats) {
    const d = fmtDistance(stats.distance, units);
    const dur = time ? time.duration : fmtDuration(stats.duration, { compact: true });
    const cells = [
      [`${d.v}`, d.u, t('panel.distance')],
      [dur, '', t('panel.duration')],
      [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')],
      drawCaloriesCell(stats)
    ];
    const cw = w / 4;
    const valueY = y + (compact ? 150 : 196);
    const labelY = y + (compact ? 182 : 232);
    cells.forEach(([v, u, k], i) => {
      const cx = x + i * cw;
      ctx.fillStyle = P.accent;
      ctx.font = `800 ${compact ? (v.length > 6 ? 36 : 42) : (v.length > 6 ? 46 : 54)}px ${MONO}`;
      ctx.fillText(v, cx, valueY);
      const vw = ctx.measureText(v).width;
      ctx.fillStyle = P.muted;
      ctx.font = `${compact ? 20 : 24}px ${font}`;
      if (u) ctx.fillText(u, cx + vw + 8, valueY);
      ctx.fillText(k, cx, labelY);
    });
    profileY = y + (compact ? 248 : (places.length ? 300 : 260));
  } else {
    profileY = y + (compact ? 132 : (places.length ? 200 : 166));
  }

  if (places.length) {
    const metaY = showStats ? y + (compact ? 220 : 272) : y + (compact ? 122 : 160);
    const routeLabel = t('export.route');
    const credit = '© OpenStreetMap';
    ctx.font = `600 ${compact ? 18 : 20}px ${font}`;
    ctx.fillStyle = P.faint;
    ctx.fillText(routeLabel, x, metaY);
    const lw = ctx.measureText(routeLabel).width;
    ctx.font = `15px ${font}`;
    const cwCredit = ctx.measureText(credit).width;
    ctx.font = `${compact ? 20 : 22}px ${font}`;
    ctx.fillStyle = P.muted;
    ctx.fillText(fitText(ctx, places.join(' → '), w - lw - cwCredit - 30), x + lw + 12, metaY);
    ctx.font = `15px ${font}`;
    ctx.fillStyle = P.faint;
    ctx.fillText(credit, x + w - cwCredit, metaY);
  }

  const brandY = y + h - (compact ? 132 : 150);
  drawProfile(ctx, stats, x, profileY, w, Math.max(120, brandY - 30 - profileY), P);
  drawBrandBlock(ctx, x, brandY, compact ? 128 : 150, P, w - (compact ? 148 : 170));
}

function drawStatCard(ctx, x, y, w, h, v, u, label, P, font) {
  roundRectPath(ctx, x, y, w, h, 18);
  ctx.fillStyle = P.cellBg;
  ctx.fill();
  ctx.strokeStyle = P.grid;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.font = `800 ${v.length > 6 ? 38 : 44}px ${MONO}`;
  ctx.fillText(v, x + 22, y + 50);
  const vw = ctx.measureText(v).width;
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${font}`;
  if (u) ctx.fillText(u, x + 22 + vw + 8, y + 50);
  ctx.fillText(label, x + 22, y + 82);
}

function drawSquarePanel(ctx, full, stats, score, W, H, mapH, P, time, places, dsn, showStats) {
  const units = get('units');
  const font = dsn.font;
  const py = mapH;
  ctx.fillStyle = P.panel;
  ctx.fillRect(0, py, W, H - py);

  ctx.textAlign = 'left';
  ctx.fillStyle = P.accent;
  ctx.fillRect(60, py + 34, 64, 6);
  ctx.fillStyle = P.text;
  ctx.font = `800 46px ${font}`;
  ctx.fillText(fitText(ctx, dsn.name, W - 120 - 190), 60, py + 92);
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${font}`;
  const activity = t(`record.activities.${full.trip.activity}`);
  const dateStr = time?.date || new Date(full.trip.createdAt).toLocaleDateString();
  const dateLine = time
    ? `${dateStr} · ${activity} · ${time.start} → ${time.end}`
    : `${dateStr} · ${activity}`;
  const dateShown = fitText(ctx, dateLine, W - 260);
  ctx.fillText(dateShown, 60, py + 128);
  const dw = ctx.measureText(dateShown).width;
  drawSignalChip(ctx, 60 + dw + 18, py + 128, signalLevel(stats.avgAcc), { on: P.accent, off: P.grid, text: P.muted });
  drawScoreBadge(ctx, score, W - 60 - 168, py + 40, P);

  const credit = places.length ? '© OpenStreetMap' : '';
  ctx.font = `15px ${font}`;
  const cwCredit = credit ? ctx.measureText(credit).width : 0;
  ctx.fillStyle = P.muted;
  ctx.font = `20px ${font}`;
  const meta = [
    `${t('export.elapsed')} ${time ? time.duration : '--'}`,
    places.join(' → ')
  ].filter(Boolean).join(' · ');
  ctx.fillText(fitText(ctx, meta, W - 120 - cwCredit - 14), 60, py + 164);
  if (credit) {
    ctx.fillStyle = P.faint;
    ctx.font = `15px ${font}`;
    ctx.fillText(credit, W - 60 - cwCredit, py + 164);
  }

  let profileY = py + 300;
  if (showStats) {
    const d = fmtDistance(stats.distance, units);
    const dur = time ? time.duration : fmtDuration(stats.duration, { compact: true });
    const cells = [
      [d.v, d.u, t('panel.distance')],
      [dur, '', t('panel.duration')],
      [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')],
      drawCaloriesCell(stats)
    ];
    const gap = 16, cw = (W - 120 - gap * 3) / 4, ch = 92, cy = py + 186;
    cells.forEach(([v, u, k], i) => drawStatCard(ctx, 60 + i * (cw + gap), cy, cw, ch, v, u, k, P, font));
  } else {
    profileY = py + 200;
  }

  const brandY = H - 110;
  drawProfile(ctx, stats, 60, profileY, W - 120, Math.max(120, brandY - 30 - profileY), P);
  drawBrandBlock(ctx, 60, brandY, 100, P, W - 120 - 115);
}

function drawCompactOverlay(ctx, stats, x, y, w, h, { score, time, places, dsn, showStats }, P) {
  const units = get('units');
  const font = dsn.font;
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 40px ${font}`;
  ctx.fillText(fitText(ctx, dsn.name, w - 150), x, y + 44);
  ctx.fillStyle = P.muted;
  ctx.font = `20px ${font}`;
  const dateStr = time?.date || '';
  ctx.fillText(fitText(ctx, [dateStr, places.join(' → ')].filter(Boolean).join(' · '), w - 150), x, y + 76);
  drawScoreBadge(ctx, score, x + w - 150, y + 4, P);
  if (showStats) {
    const d = fmtDistance(stats.distance, units);
    const dur = time ? time.duration : fmtDuration(stats.duration, { compact: true });
    const cells = [
      [d.v, d.u, t('panel.distance')],
      [dur, '', t('panel.duration')],
      [`${Math.round(stats.ascent)}`, 'm', t('panel.ascent')],
      drawCaloriesCell(stats)
    ];
    const cw = w / 4;
    cells.forEach(([v, u, k], i) => {
      const cx = x + i * cw;
      ctx.fillStyle = P.accent;
      ctx.font = `800 ${v.length > 6 ? 34 : 40}px ${MONO}`;
      ctx.fillText(v, cx, y + 132);
      const vw = ctx.measureText(v).width;
      ctx.fillStyle = P.muted;
      ctx.font = `20px ${font}`;
      if (u) ctx.fillText(u, cx + vw + 6, y + 132);
      ctx.fillText(k, cx, y + 162);
    });
  }
  const qrSize = Math.max(58, Math.min(84, h - 230));
  if (h > 260 && qrSize >= 58) drawQr(ctx, SITE_URL, x, y + h - qrSize - 4, qrSize);
  const brandTextX = x + qrSize + 18;
  const brandTextW = w - qrSize - 20;
  ctx.fillStyle = P.muted;
  ctx.font = `600 15px ${font}`;
  ctx.fillText(fitText(ctx, t('app.slogan1'), brandTextW), brandTextX, y + h - 48);
  ctx.fillText(fitText(ctx, t('app.slogan2'), brandTextW), brandTextX, y + h - 30);
  ctx.fillStyle = P.faint;
  ctx.font = `13px ${font}`;
  ctx.fillText(SITE_URL, brandTextX, y + h - 8);
}

/**
 * @returns {Promise<{canvas, blob, usedVectorFallback:boolean}>}
 */
export async function generatePoster(full, {
  size = 'vertical',
  style: styleInput = null,
  privacy = { radius: 300, hideSensitive: true },
  vectorOnly = false,
  basemapId = '',
  onProgress
}: any = {}): Promise<any> {
  const style = normalizeShareStyle(styleInput || {});
  const basePalette = canvasPalette();
  const P = designedPalette(basePalette, style.background);
  await loadBrandFonts();
  const cropped = await bridgeTrackGapsForExport(full, applyPrivacy(full, privacy), privacy);
  const stats = computeStats(cropped.segments, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  });
  const score = computeTripScore(stats, full.trip.activity);
  const time = tripTimeInfo(full);
  const dsn = design(full, style);
  const trackColor = trackColorValue(style.trackColor, '');
  let mapP = 0, placeP = 0;
  const report = () => onProgress?.(0.9 * mapP + 0.1 * placeP);
  const placesPromise = routePlaceNames(cropped.segments, {
    max: 6,
    onProgress: (p) => { placeP = p; report(); }
  });
  const W = 1080;
  const layout = posterLayout(size, style);
  const H = layout.H;
  const square = size === 'square';
  const overlay = style.layout === 'overlay';
  const overlayMapCap = square ? 0.70 : 0.72;
  const mapH = overlay
    ? Math.round(H * Math.min(overlayMapCap, style.mapRatio / 100))
    : layout.mapH;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = P.panel;
  ctx.fillRect(0, 0, W, H);
  const m = await prepareMap({
    w: W, h: mapH, pad: overlay ? 110 : (square ? 80 : 90), segments: cropped.segments, waypoints: cropped.waypoints,
    basemapId, vectorOnly, onProgress: (p) => { mapP = p; report(); }
  });
  const places = await placesPromise;
  ctx.drawImage(m.bg, 0, 0);
  paintTrack(ctx, m.fit, m.segments, m.waypoints, {
    lineWidth: style.trackWidth,
    dotRadius: 12,
    trackColor,
    hideStart: !!privacy.hideStartIcon,
    hideEnd: !!privacy.hideEndIcon,
    headKind: 'end',
    darkBg: m.darkBg
  });

  if (!overlay) {
    ctx.fillStyle = P.accent;
    ctx.fillRect(0, mapH - 8, W, 8);
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, mapH, W, H - mapH);
    if (square) {
      drawSquarePanel(ctx, full, stats, score, W, H, mapH, P, time, places, dsn, style.statsCard);
    } else {
      ctx.fillStyle = P.accent;
      ctx.fillRect(60, mapH + 36, 64, 6);
      drawInfoPanel(ctx, full, stats, 60, mapH + 60, W - 120, H - mapH - 100, {
        score, time, places, dsn, showStats: style.statsCard
      }, P);
    }
  } else {
    const overlap = square ? 64 : 96;
    const cardX = 34, cardY = mapH - overlap, cardW = W - 68, cardH = H - cardY - 30;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.26)';
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 14;
    roundRectPath(ctx, cardX, cardY, cardW, cardH, 34);
    ctx.fillStyle = P.panel;
    ctx.fill();
    ctx.restore();
    roundRectPath(ctx, cardX, cardY, cardW, cardH, 34);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    const innerX = cardX + (square ? 28 : 38);
    const innerY = cardY + (square ? 24 : 34);
    const innerW = cardW - (square ? 56 : 76);
    if (square) {
      drawCompactOverlay(ctx, stats, innerX, innerY, innerW, cardH - 48, {
        score, time, places, dsn, showStats: style.statsCard
      }, P);
    } else {
      ctx.fillStyle = P.accent;
      ctx.fillRect(innerX, cardY + 28, 64, 6);
      drawInfoPanel(ctx, full, stats, innerX, cardY + 58, innerW, cardH - 92, {
        score, time, places, dsn, showStats: style.statsCard, compact: true
      }, P);
    }
  }

  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return { canvas, blob, usedVectorFallback: m.vector };
}
