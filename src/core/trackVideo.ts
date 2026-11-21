// Track recap video: 1080×1920, top = progressive map replay, bottom = live
// stats synced to the playback position. Rendered in realtime on an offscreen
// canvas and captured via captureStream + MediaRecorder (mp4 when available).
import { applyPrivacy } from './privacy';
import { computeStats } from './stats';
import { prepareMap, paintTrack } from './mapPaint';
import { computeTripScore, drawScoreBadge, fitText } from './tripScore';
import { canvasPalette } from './palette';
import { fmtDistance, fmtDuration, fmtSpeed, fmtPace, fmtAltitude, signalLevel, haversine } from './geo';
import { loadBrandFonts, drawQr, SITE_URL, SPORT_FONT } from './brand';
import { tripTimeInfo, routePlaceNames } from './shareInfo';
import { estimateCalories } from './calories';
import { get } from './settings';
import { t } from './i18n';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const SIG_KEYS = ['', 'Weak', 'Fair', 'Good', 'Strong'];
const W = 1080, H = 1920, MAP_H = 1080;
const INTRO_MS = 2600, OUTRO_MS = 3400, FADE_MS = 500;

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
  ctx.font = `700 52px ${SPORT_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(v, x, y);
  const vw = ctx.measureText(v).width;
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  if (u) ctx.fillText(u, x + vw + 8, y);
  ctx.fillText(label, x, y + 34);
}

function drawSignalCell(ctx, x, y, avgAcc, P) {
  const lv = signalLevel(avgAcc);
  const hs = [16, 24, 32, 40], bw = 9, gap = 5;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i < lv ? P.accent : P.grid;
    ctx.fillRect(x + i * (bw + gap), y - hs[i], bw, hs[i]);
  }
  ctx.fillStyle = lv ? P.accent : P.muted;
  ctx.font = `700 34px ${SPORT_FONT}`;
  ctx.textAlign = 'left';
  ctx.fillText(lv ? t(`panel.sig${SIG_KEYS[lv]}`) : '--', x + 4 * (bw + gap) + 8, y - 4);
  ctx.fillStyle = P.muted;
  ctx.font = `22px ${FONT}`;
  ctx.fillText(`${t('panel.signal')}${avgAcc != null ? ` ±${Math.round(avgAcc)}m` : ''}`, x, y + 34);
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
  const stats = computeStats(cropped.segments, {
    ascentThreshold: get('ascentThreshold'),
    activity: full.trip.activity,
    weightKg: get('weightKg')
  });
  const N = stats.pointCount;
  if (N < 2) throw new Error('no-track');
  const score = computeTripScore(stats, full.trip.activity);
  const time = tripTimeInfo(full);
  const P = canvasPalette();
  await loadBrandFonts();

  let lastProg = 0;
  const report = (p: number) => { if (p > lastProg) { lastProg = p; onProgress?.(p); } };
  const placesPromise = routePlaceNames(cropped.segments, {
    max: 6, signal,
    onProgress: (p) => report(0.02 + 0.08 * p)
  });
  const m = await prepareMap({
    w: W, h: MAP_H, pad: 80, segments: cropped.segments, waypoints: cropped.waypoints,
    basemapId, vectorOnly, onProgress: (p) => report(p * 0.1)
  });
  const places = await placesPromise;
  report(0.1);
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

  // cumulative calories along the replay (MET uses current moving average)
  const flatPts = cropped.segments.flatMap((s) => s.points);
  const cumKcal = new Array(N);
  let movingAcc = 0;
  for (let i = 0; i < N; i++) {
    if (i > 0) {
      const a = flatPts[i - 1], b = flatPts[i];
      if (a?.t && b?.t) {
        const dt = b.t - a.t;
        if (dt > 0 && dt <= 60000 && haversine(a.lat, a.lon, b.lat, b.lon) / (dt / 1000) > 0.5) {
          movingAcc += Math.min(dt, 60000);
        }
      }
    }
    const soFar = stats.series.d[i] || 0;
    cumKcal[i] = estimateCalories(full.trip.activity, movingAcc, movingAcc > 0 ? soFar / (movingAcc / 1000) : 0, get('weightKg'));
  }

  // normalised route silhouette for the intro reveal
  const introShape = (() => {
    const step = Math.max(1, Math.ceil(flatPts.length / 700));
    const pts = flatPts.filter((_, i) => i % step === 0 || i === flatPts.length - 1);
    if (pts.length < 2) return null;
    const midLat = (pts.reduce((a, p) => a + p.lat, 0) / pts.length) * Math.PI / 180;
    const xs = pts.map((p) => p.lon * Math.cos(midLat));
    const ys = pts.map((p) => p.lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return {
      w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY),
      pts: pts.map((_, i) => ({ x: xs[i] - minX, y: maxY - ys[i] }))
    };
  })();
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const name = (full.trip.name || t('record.newTripName')).slice(0, 20);
  const dateStr = time?.date || new Date(full.trip.createdAt).toLocaleDateString();
  const activity = t(`record.activities.${full.trip.activity}`);

  function drawFrame(idx, u) {
    ctx.drawImage(m.bg, 0, 0);
    paintTrack(ctx, m.fit, render.segs, m.waypoints, {
      upto: render.origIdx ? countUpTo(render.origIdx, idx) : idx + 1,
      lineWidth: 9, dotRadius: 14
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
    const dateLine = time ? `${dateStr} · ${activity} · ${time.start} → ${time.end}` : `${dateStr} · ${activity}`;
    ctx.fillText(fitText(ctx, dateLine, W - 120 - 190), 60, py0 + 130);
    drawScoreBadge(ctx, score, W - 60 - 168, py0 + 52, P);
    ctx.fillStyle = P.muted;
    ctx.font = `24px ${FONT}`;
    const metaLine = [
      time ? `${t('export.elapsed')} ${time.duration}` : '',
      places.join(' → ')
    ].filter(Boolean).join(' · ');
    ctx.fillText(fitText(ctx, metaLine, W - 120), 60, py0 + 168);

    const d = fmtDistance(stats.series.d[idx], units);
    const sp = fmtSpeed(stats.series.speed[idx], units);
    const alt = fmtAltitude(stats.series.alt[idx] ?? stats.series.rawAlt[idx], units);
    const asc = fmtAltitude(cumAsc[idx], units);
    const desc = fmtAltitude(cumDesc[idx], units);
    const cw = (W - 120) / 4;
    const row1 = py0 + 228, row2 = py0 + 354;
    drawCell(ctx, 60, row1, d.v, d.u, t('panel.distance'), P);
    drawCell(ctx, 60 + cw, row1, fmtDuration(span > 0 ? u * span : null), '', t('export.videoElapsed'), P);
    drawCell(ctx, 60 + cw * 2, row1, sp.v, sp.u, t('panel.speed'), P);
    drawSignalCell(ctx, 60 + cw * 3, row1, stats.avgAcc, P);
    drawCell(ctx, 60, row2, alt.v, alt.u, t('panel.altitude'), P);
    drawCell(ctx, 60 + cw, row2, asc.v, asc.u, t('panel.ascent'), P);
    drawCell(ctx, 60 + cw * 2, row2, desc.v, desc.u, t('panel.descent'), P);
    const kcal = cumKcal[idx];
    drawCell(ctx, 60 + cw * 3, row2, kcal != null ? String(Math.round(kcal)) : '—', kcal != null ? 'kcal' : '', t('panel.calories'), P);

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
    ctx.fillText(`${t('app.name')} · ${SITE_URL}`, 60, H - 36);
    if (places.length) {
      ctx.textAlign = 'right';
      ctx.fillText('© OpenStreetMap', W - 60, H - 36);
      ctx.textAlign = 'left';
    }
  }

  // Opening recap card: trip identity, route silhouette and headline stats.
  // Promo/QR lives in the outro instead, so the video opens on the trip itself.
  function drawIntro(p) {
    const ease = 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3);
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 800, 40, W / 2, 800, 760);
    glow.addColorStop(0, P.accentSoft);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 220, W, 1200);

    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = `700 36px ${SPORT_FONT}`;
    ctx.fillText(t('app.name'), W / 2, 168);
    ctx.fillStyle = P.muted;
    ctx.font = `600 24px ${FONT}`;
    ctx.fillText(t('export.videoRecap'), W / 2, 214);

    ctx.globalAlpha = Math.min(1, p * 3);
    ctx.fillStyle = P.text;
    ctx.font = `800 86px ${FONT}`;
    ctx.fillText(fitText(ctx, name, W - 160), W / 2, 336);
    ctx.fillStyle = P.muted;
    ctx.font = `26px ${FONT}`;
    const introTime = time ? ` · ${time.start} → ${time.end}` : '';
    ctx.fillText(`${activity} · ${dateStr}${introTime}`, W / 2, 388);
    ctx.globalAlpha = 1;

    ctx.fillStyle = P.accent;
    const ruleW = 120 * ease;
    ctx.fillRect(W / 2 - ruleW / 2, 420, ruleW, 6);

    if (introShape) {
      const bx = 140, by = 470, bw = 800, bh = 520;
      const scale = Math.min(bw / introShape.w, bh / introShape.h);
      const ox = bx + (bw - introShape.w * scale) / 2;
      const oy = by + (bh - introShape.h * scale) / 2;
      const xy = (pt) => [ox + pt.x * scale, oy + pt.y * scale];
      const path = (n) => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const [x, y] = xy(introShape.pts[i]);
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
      };
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = P.accentLine;
      ctx.lineWidth = 10;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      path(introShape.pts.length);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 7;
      ctx.shadowColor = P.accent;
      ctx.shadowBlur = 18;
      const n = Math.max(2, Math.ceil(introShape.pts.length * ease));
      path(n);
      ctx.stroke();
      ctx.shadowBlur = 0;
      const [sx, sy] = xy(introShape.pts[0]);
      ctx.fillStyle = P.amber;
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.fill();
      const [ex, ey] = xy(introShape.pts[n - 1]);
      ctx.fillStyle = P.panel;
      ctx.beginPath();
      ctx.arc(ex, ey, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.accent;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    ctx.globalAlpha = Math.max(0, Math.min(1, (p - 0.55) / 0.35));
    const d = fmtDistance(stats.distance, units);
    const cols = [
      [d.v, d.u, t('panel.distance')],
      [time ? time.duration : fmtDuration(stats.duration, { compact: true }), '', t('panel.duration')],
      stats.calories != null
        ? [String(Math.round(stats.calories)), 'kcal', t('panel.calories')]
        : [String(Math.round(stats.ascent)), 'm', t('panel.ascent')]
    ];
    const colW = W / 3, cy = 1160;
    cols.forEach(([v, u, k], i) => {
      const cx = colW * i + colW / 2;
      ctx.font = `700 58px ${SPORT_FONT}`;
      const vw = ctx.measureText(v).width;
      ctx.font = `500 24px ${FONT}`;
      const uw = u ? ctx.measureText(u).width + 6 : 0;
      const startX = cx - (vw + uw) / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = P.accent;
      ctx.font = `700 58px ${SPORT_FONT}`;
      ctx.fillText(v, startX, cy);
      if (u) {
        ctx.fillStyle = P.muted;
        ctx.font = `500 24px ${FONT}`;
        ctx.fillText(u, startX + vw + 6, cy);
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = P.muted;
      ctx.font = `24px ${FONT}`;
      ctx.fillText(k, cx, cy + 38);
    });
    if (places.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = P.muted;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillText(fitText(ctx, `${t('export.route')}  ${places.join(' → ')}`, W - 160), W / 2, 1258);
      ctx.fillStyle = P.faint;
      ctx.font = `18px ${FONT}`;
      ctx.fillText('© OpenStreetMap contributors', W / 2, 1292);
    }
    ctx.globalAlpha = 1;
  }

  // Closing brand card — the QR / call-to-action lives here, after the replay.
  function drawOutro(alpha) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = `700 44px ${SPORT_FONT}`;
    ctx.fillText(t('app.name'), W / 2, 470);
    ctx.fillStyle = P.text;
    ctx.font = `800 72px ${FONT}`;
    ctx.fillText(t('export.videoThanksTitle'), W / 2, 592);
    ctx.fillStyle = P.accent;
    ctx.fillRect(W / 2 - 40, 634, 80, 6);
    ctx.fillStyle = P.muted;
    ctx.font = `30px ${FONT}`;
    ctx.fillText(t('export.videoThanksSub'), W / 2, 704);
    ctx.fillStyle = P.accent;
    ctx.font = `600 40px ${SPORT_FONT}`;
    ctx.fillText(t('app.slogan'), W / 2, 790);
    const qr = 320, qy = 850;
    drawQr(ctx, SITE_URL, (W - qr) / 2, qy, qr);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.muted;
    ctx.font = `600 32px ${SPORT_FONT}`;
    ctx.fillText(t('app.scan'), W / 2, qy + qr + 56);
    ctx.fillStyle = P.text;
    ctx.font = `600 28px ${SPORT_FONT}`;
    ctx.fillText(SITE_URL, W / 2, qy + qr + 104);
    ctx.fillStyle = P.faint;
    ctx.font = `500 24px ${SPORT_FONT}`;
    ctx.fillText(t('app.brandLine'), W / 2, qy + qr + 150);
    ctx.restore();
  }

  const mime = pickMime();
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(250);

  const playMs = seconds * 1000;
  const totalMs = INTRO_MS + playMs + OUTRO_MS; // recap intro, replay, brand outro
  let idx = 0, aborted = false;
  drawFrame(0, 0);
  drawIntro(1);
  let cover = '';
  try { cover = canvas.toDataURL('image/jpeg', 0.82); } catch { /* canvas tainted by tiles */ }
  await new Promise<void>((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      if (signal?.aborted) { aborted = true; resolve(); return; }
      const el = now - t0;
      const u = el <= INTRO_MS ? 0 : Math.min(1, (el - INTRO_MS) / playMs);
      const introA = el >= INTRO_MS ? 0 : el > INTRO_MS - FADE_MS ? (INTRO_MS - el) / FADE_MS : 1;
      const outroA = Math.min(1, Math.max(0, (el - INTRO_MS - playMs) / FADE_MS));
      while (idx < N - 1 && pointU[idx + 1] <= u) idx++;
      drawFrame(idx, u);
      if (introA > 0) {
        ctx.save();
        ctx.globalAlpha = introA;
        drawIntro(Math.min(1, el / (INTRO_MS * 0.72)));
        ctx.restore();
      }
      if (outroA > 0) drawOutro(outroA);
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