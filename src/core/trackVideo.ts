// Track recap video: 1080×1920, top = progressive map replay, bottom = live
// stats synced to the playback position. Rendered in realtime on an offscreen
// canvas and captured via captureStream + MediaRecorder (mp4 when available).
import { applyPrivacy } from './privacy';
import { computeStats } from './stats';
import { prepareMap, paintTrack } from './mapPaint';
import { computeTripScore, drawScoreBadge, fitText } from './tripScore';
import { canvasPalette } from './palette';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude } from './geo';
import { get } from './settings';
import { t } from './i18n';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const W = 1080, H = 1920, MAP_H = 1080;

export const videoSupported = () =>
  typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

// Heavy tracks drop capture frames below 30fps, which truncates the recorded
// timeline; stroke a decimated path instead (stats stay full-resolution).
function decimate(segments, maxPts = 2000) {
  const total = segments.reduce((a, s) => a + s.points.length, 0);
  if (total <= maxPts) return { segs: segments, origIdx: null };
  const k = Math.ceil(total / maxPts);
  const segs = [], origIdx = [];
  let flat = 0;
  for (const s of segments) {
    const pts = [];
    for (let i = 0; i < s.points.length; i++) {
      if (i % k === 0 || i === s.points.length - 1) { pts.push(s.points[i]); origIdx.push(flat + i); }
    }
    if (pts.length) segs.push({ ...s, points: pts });
    flat += s.points.length;
  }
  return { segs, origIdx };
}

function countUpTo(origIdx, idx) {
  let lo = 0, hi = origIdx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (origIdx[mid] <= idx) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function cumulativeAscentDescent(alts, threshold) {
  const asc = [], desc = [];
  let a = 0, d = 0, ref = null;
  for (const v of alts) {
    if (v != null && isFinite(v)) {
      if (ref == null) ref = v;
      const delta = v - ref;
      if (delta >= threshold) { a += delta; ref = v; }
      else if (delta <= -threshold) { d += -delta; ref = v; }
    }
    asc.push(a); desc.push(d);
  }
  return { asc, desc };
}

function drawCell(ctx, x, y, v, u, label, P) {
  ctx.fillStyle = P.accent;
  ctx.font = `800 52px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(v, x, y);
  const vw = ctx.measureText(v).width;
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  if (u) ctx.fillText(u, x + vw + 8, y);
  ctx.fillText(label, x, y + 34);
}

function drawProfileCursor(ctx, prof, meta, curD, curA, x, y, w, h, P) {
  if (prof.length < 2) return;
  const { minA, maxA, maxD } = meta;
  const span = Math.max(1, maxA - minA);
  const px = (d) => x + (d / maxD) * w;
  const py = (a) => y + h - ((a - minA) / span) * (h - 10) - 5;

  ctx.beginPath();
  prof.forEach(([d, a], i) => { i ? ctx.lineTo(px(d), py(a)) : ctx.moveTo(px(d), py(a)); });
  ctx.strokeStyle = P.accentLine;
  ctx.lineWidth = 3;
  ctx.stroke();

  let n = 0;
  while (n < prof.length && prof[n][0] <= curD) n++;
  if (n >= 2) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const [d, a] = prof[i]; i ? ctx.lineTo(px(d), py(a)) : ctx.moveTo(px(d), py(a)); }
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.lineTo(px(prof[n - 1][0]), y + h);
    ctx.lineTo(px(prof[0][0]), y + h);
    ctx.closePath();
    ctx.fillStyle = P.accentSoft;
    ctx.fill();
  }
  const cx = px(curD);
  ctx.strokeStyle = P.amber;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx, y + h); ctx.stroke();
  if (curA != null) {
    ctx.fillStyle = P.amber;
    ctx.beginPath(); ctx.arc(cx, py(curA), 7, 0, 7); ctx.fill();
  }
  ctx.fillStyle = P.muted;
  ctx.font = `20px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${Math.round(maxA)}m`, x + 4, y + 18);
  ctx.fillText(`${Math.round(minA)}m`, x + 4, y + h - 6);
}

/**
 * @returns {Promise<{blob, mime, width, height, seconds, usedVectorFallback:boolean}>}
 */
export async function generateTrackVideo(full, {
  privacy = { radius: 300, hideSensitive: true },
  vectorOnly = false,
  basemapId = '',
  seconds = 15,
  onProgress,
  signal
}: any = {}): Promise<any> {
  if (!videoSupported()) throw new Error('video-unsupported');
  const cropped = applyPrivacy(full, privacy);
  const stats = computeStats(cropped.segments, { ascentThreshold: get('ascentThreshold') });
  const N = stats.pointCount;
  if (N < 2) throw new Error('no-track');
  const score = computeTripScore(stats, full.trip.activity);
  const P = canvasPalette();

  const m = await prepareMap({
    w: W, h: MAP_H, pad: 80, segments: cropped.segments, waypoints: cropped.waypoints,
    basemapId, vectorOnly, onProgress: (p) => onProgress?.(p * 0.1)
  });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // playback position per point: real timestamps when present, else uniform
  const ts = stats.series.t;
  const firstT = ts.find((v) => v != null);
  let lastT = null;
  for (let i = ts.length - 1; i >= 0; i--) { if (ts[i] != null) { lastT = ts[i]; break; } }
  const span = firstT != null && lastT != null && lastT > firstT ? lastT - firstT : 0;
  const pointU = ts.map((v, i) => (span > 0 && v != null ? (v - firstT) / span : i / (N - 1)));
  for (let i = 1; i < N; i++) if (pointU[i] < pointU[i - 1]) pointU[i] = pointU[i - 1];

  const { asc: cumAsc, desc: cumDesc } = cumulativeAscentDescent(stats.series.alt, get('ascentThreshold') ?? 4);
  const render = decimate(m.segments);
  const profAll = stats.series.alt.map((a, i) => [stats.series.d[i], a]).filter(([, a]) => a != null);
  const pk = Math.max(1, Math.ceil(profAll.length / 1200));
  const prof = profAll.filter((_, i) => i % pk === 0 || i === profAll.length - 1);
  const profMeta = prof.length ? {
    minA: Math.min(...prof.map((v) => v[1])),
    maxA: Math.max(...prof.map((v) => v[1])),
    maxD: stats.series.d[N - 1] || 1
  } : null;
  const units = get('units');
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const name = (full.trip.name || t('record.newTripName')).slice(0, 20);
  const dateStr = new Date(full.trip.createdAt).toLocaleDateString();
  const activity = t(`record.activities.${full.trip.activity}`);

  function drawFrame(idx, u) {
    ctx.drawImage(m.bg, 0, 0);
    paintTrack(ctx, m.fit, render.segs, m.waypoints, {
      upto: render.origIdx ? countUpTo(render.origIdx, idx) : idx + 1,
      lineWidth: 7, dotRadius: 13
    });
    ctx.fillStyle = P.progressTrack;
    ctx.fillRect(0, MAP_H - 8, W, 8);
    ctx.fillStyle = P.accent;
    ctx.fillRect(0, MAP_H - 8, W * u, 8);

    const py0 = MAP_H;
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, py0, W, H - py0);
    ctx.fillStyle = P.accent;
    ctx.fillRect(60, py0 + 30, 64, 6);
    ctx.textAlign = 'left';
    ctx.fillStyle = P.text;
    ctx.font = `800 44px ${FONT}`;
    ctx.fillText(fitText(ctx, name, W - 120 - 190), 60, py0 + 92);
    ctx.fillStyle = P.muted;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(`${dateStr} · ${activity}`, 60, py0 + 130);
    drawScoreBadge(ctx, score, W - 60 - 168, py0 + 52, P);
    ctx.fillStyle = P.muted;
    ctx.font = `24px ${FONT}`;
    ctx.fillText(fitText(ctx, score.comment, W - 120), 60, py0 + 168);

    const d = fmtDistance(stats.series.d[idx], units);
    const sp = fmtSpeed(stats.series.speed[idx], units);
    const alt = fmtAltitude(stats.series.alt[idx] ?? stats.series.rawAlt[idx], units);
    const asc = fmtAltitude(cumAsc[idx], units);
    const desc = fmtAltitude(cumDesc[idx], units);
    const cw = (W - 120) / 3;
    const row1 = py0 + 228, row2 = py0 + 354;
    drawCell(ctx, 60, row1, d.v, d.u, t('panel.distance'), P);
    drawCell(ctx, 60 + cw, row1, fmtDuration(span > 0 ? u * span : null), '', t('export.videoElapsed'), P);
    drawCell(ctx, 60 + cw * 2, row1, sp.v, sp.u, t('panel.speed'), P);
    drawCell(ctx, 60, row2, alt.v, alt.u, t('panel.altitude'), P);
    drawCell(ctx, 60 + cw, row2, asc.v, asc.u, t('panel.ascent'), P);
    drawCell(ctx, 60 + cw * 2, row2, desc.v, desc.u, t('panel.descent'), P);

    const pace = fmtPace(stats.series.speed[idx], units);
    const slope = stats.series.slope[idx];
    ctx.fillStyle = P.muted;
    ctx.font = `26px ${MONO}`;
    ctx.fillText(
      `${t('panel.pace')} ${pace.v}${pace.u}   ·   ${t('panel.slope')} ${slope != null ? slope.toFixed(1) + '%' : '--'}   ·   ${idx + 1}/${N}`,
      60, py0 + 430
    );

    drawProfileCursor(ctx, prof, profMeta, stats.series.d[idx] || 0, stats.series.alt[idx], 60, py0 + 470, W - 120, 240, P);

    ctx.fillStyle = P.faint;
    ctx.font = `20px ${FONT}`;
    ctx.fillText(`${t('app.name')} · ${m.label} · WGS-84`, 60, H - 36);
  }

  const mime = pickMime();
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(250);

  const playMs = seconds * 1000;
  const totalMs = playMs + 800; // hold the final frame briefly
  let idx = 0, aborted = false;
  drawFrame(0, 0);
  let cover = '';
  try { cover = canvas.toDataURL('image/jpeg', 0.82); } catch { /* canvas tainted by tiles */ }
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      if (signal?.aborted) { aborted = true; resolve(); return; }
      const el = now - t0;
      const u = Math.min(1, el / playMs);
      while (idx < N - 1 && pointU[idx + 1] <= u) idx++;
      drawFrame(idx, u);
      onProgress?.(0.1 + 0.9 * Math.min(1, el / totalMs));
      if (el >= totalMs) { resolve(); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  try { rec.stop(); } catch { /* already stopped */ }
  stream.getTracks().forEach((tr) => tr.stop());
  await stopped;
  if (aborted) throw new DOMException('Aborted', 'AbortError');

  const type = (mime || 'video/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  return { blob, mime: type, width: W, height: H, seconds, usedVectorFallback: m.vector, cover };
}