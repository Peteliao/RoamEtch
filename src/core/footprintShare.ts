// Yearly footprint artwork: aggregate-only share card and short recap clip.
import { canvasPalette } from './palette';
import { drawBrandMark, drawQr, loadBrandFonts, SITE_URL, SPORT_FONT } from './brand';
import { fitText, roundRectPath } from './tripScore';
import { fmtAltitude, fmtDistance } from './geo';
import { recapFootprint } from './footprint';
import { currentLang, t } from './i18n';
import { get } from './settings';
import { createMusicSession } from './music';
import { makeVideoRecorder, videoSupported } from './videoCapture';
import { prepareMap } from './mapPaint';
import { MUSIC_PREF_RANDOM } from './music';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'ui-monospace, "SF Mono", Consolas, monospace';
const M = 72;
const IMG_W = 1080, IMG_H = 1620;
const VID_W = 1080, VID_H = 1920;
const VIDEO_MS = 9000;

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);

export function monthLabel(month: number, lang = currentLang()) {
  return new Date(2024, month - 1, 1).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short' });
}

export function footprintCaption(fp, units = get('units')) {
  const r = recapFootprint(fp, units);
  return t('trips.footprintCaption', {
    year: r.year,
    trips: r.trips,
    distance: `${r.distance.v}${r.distance.u}`,
    ascent: `${r.ascent.v}${r.ascent.u}`,
    days: r.days,
    months: r.activeMonths,
    cities: r.cityCount,
    url: SITE_URL
  });
}

function drawBackground(ctx: CanvasRenderingContext2D, P, highContrast: boolean, w: number, h: number, phase = 0) {
  if (highContrast) {
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, w, h);
    const wash = ctx.createLinearGradient(0, 0, w, h * 0.55);
    wash.addColorStop(0, rgba(P.accent, 0.08));
    wash.addColorStop(1, rgba(P.accent, 0));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, w, h * 0.55);
    ctx.strokeStyle = rgba(P.text, 0.1);
    ctx.lineWidth = 1;
    for (let y = 150; y < h; y += 96) {
      ctx.beginPath();
      ctx.moveTo(M, y);
      ctx.lineTo(w - M, y);
      ctx.stroke();
    }
    return;
  }

  const g = ctx.createLinearGradient(0, 0, w * 0.8, h);
  g.addColorStop(0, P.panel);
  g.addColorStop(0.58, P.vectorBg);
  g.addColorStop(1, P.panel);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const dark = P.panel === '#000000';
  const glow = (cx, cy, rad, color, alpha) => {
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    rg.addColorStop(0, rgba(color, alpha));
    rg.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  };
  glow(w * 0.9 + Math.sin(phase) * 30, 120, 560, P.accent, dark ? 0.18 : 0.1);
  glow(w * 0.04, h * 0.86, 480, P.amber, dark ? 0.07 : 0.05);

  ctx.strokeStyle = highContrast ? rgba(P.text, 0.12) : P.grid;
  ctx.lineWidth = 1;
  const step = 132;
  for (let x = M; x <= w - M; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 170);
    ctx.lineTo(x, h - 170);
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(P.accent, dark ? 0.08 : 0.07);
  ctx.lineWidth = 1.5;
  for (const [cx, cy, rx, ry, rot] of [
    [w * 0.84, 420, 230, 110, -0.24],
    [w * 0.14, h * 0.66, 190, 90, 0.3],
    [w * 0.76, h * 0.9, 250, 120, 0.12]
  ]) {
    for (const k of [1, 0.68, 0.38]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * k, ry * k, rot, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function drawHeader(ctx: CanvasRenderingContext2D, P, highContrast: boolean, year: number) {
  drawBrandMark(ctx, M, 62, 64);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.text;
  ctx.font = `800 38px ${FONT}`;
  ctx.fillText(t('app.name'), M + 84, 99);
  ctx.fillStyle = P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(t('app.tagline'), M + 85, 128);

  const badge = String(year);
  ctx.font = `700 28px ${SPORT_FONT}`;
  const bw = Math.max(94, ctx.measureText(badge).width + 52);
  roundRectPath(ctx, 1080 - M - bw, 72, bw, 48, 24);
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
  ctx.fillText(badge, 1080 - M - bw + 26, 105);
}

function drawHero(ctx: CanvasRenderingContext2D, P, highContrast: boolean, r, topY: number, reveal = 1) {
  ctx.save();
  ctx.globalAlpha = reveal;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = P.accent;
  ctx.font = `700 21px ${FONT}`;
  ctx.fillText(t('trips.footprintTitle').toUpperCase(), M, topY);

  ctx.fillStyle = P.text;
  ctx.font = `800 186px ${SPORT_FONT}`;
  ctx.fillText(String(r.year), M, topY + 162);
  const yearW = ctx.measureText(String(r.year)).width;

  ctx.fillStyle = P.accent;
  ctx.font = `800 34px ${FONT}`;
  ctx.fillText(t('trips.footprintHeadline'), M + yearW + 26, topY + 126);

  ctx.fillStyle = P.muted;
  ctx.font = `500 31px ${FONT}`;
  ctx.fillText(fitText(ctx, t('trips.footprintSub'), 900), M, topY + 216);

  if (highContrast) {
    ctx.fillStyle = P.accent;
    ctx.fillRect(M, topY + 246, 118, 6);
  } else {
    ctx.fillStyle = rgba(P.accent, 0.7);
    ctx.fillRect(M, topY + 246, 118, 6);
  }
  ctx.restore();
}

function drawKpiCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean, r, x, y, w, h, reveal = 1) {
  ctx.save();
  ctx.globalAlpha = reveal;
  if (!highContrast) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 12;
  }
  roundRectPath(ctx, x, y, w, h, 30);
  ctx.fillStyle = P.panel;
  ctx.fill();
  if (!highContrast) {
    ctx.fillStyle = P.cellBg;
    ctx.fill();
  }
  if (!highContrast) ctx.restore();
  ctx.strokeStyle = highContrast ? P.text : P.grid;
  ctx.lineWidth = highContrast ? 3 : 1.5;
  roundRectPath(ctx, x, y, w, h, 30);
  ctx.stroke();

  const cells = [
    [`${r.distance.v}${r.distance.u}`, t('analysis.distance')],
    [String(r.trips), t('trips.sumTrips')],
    [String(r.days), t('trips.sumDays')],
    [`${r.ascent.v}${r.ascent.u}`, t('analysis.ascent')]
  ];
  const cw = w / cells.length;
  cells.forEach(([value, label], i) => {
    const cx = x + cw * i + cw / 2;
    if (i > 0) {
      ctx.strokeStyle = highContrast ? rgba(P.text, 0.24) : P.grid;
      ctx.lineWidth = highContrast ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x + cw * i, y + 34);
      ctx.lineTo(x + cw * i, y + h - 30);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = i === 0 ? P.accent : P.text;
    ctx.font = `700 ${i === 0 ? 52 : 54}px ${SPORT_FONT}`;
    ctx.fillText(fitText(ctx, value, cw - 36), cx, y + h * 0.56);
    ctx.fillStyle = P.muted;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(fitText(ctx, label, cw - 34), cx, y + h - 40);
  });
  ctx.restore();
}

function drawMonthCard(ctx: CanvasRenderingContext2D, P, highContrast: boolean, fp, r, x, y, w, h, reveal = 1, lang = currentLang()) {
  ctx.save();
  ctx.globalAlpha = reveal;
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

  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `700 27px ${FONT}`;
  ctx.fillText(t('trips.footprintMonths'), x + 38, y + 51);
  ctx.textAlign = 'right';
  ctx.fillStyle = P.accent;
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(t('trips.footprintActive', { n: r.activeMonths }), x + w - 38, y + 50);

  const left = x + 42, right = x + w - 42;
  const baseY = y + h - 72;
  const maxBarH = h - 165;
  const gap = Math.max(8, Math.round((right - left) * 0.012));
  const bw = (right - left - gap * 11) / 12;
  const revealBars = clamp01((reveal - 0.12) / 0.88);

  ctx.strokeStyle = highContrast ? rgba(P.text, 0.18) : P.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, baseY);
  ctx.lineTo(right, baseY);
  ctx.stroke();

  fp.months.forEach((m, i) => {
    const bx = left + i * (bw + gap);
    const local = easeOut(revealBars * 1.32 - i * 0.035);
    const bh = Math.max(m.distance > 0 ? 3 : 0, (m.distance / r.maxMonthDistance) * maxBarH * local);
    const topMonth = r.topMonth && m.month === r.topMonth.month;
    if (!highContrast) {
      const barG = ctx.createLinearGradient(0, baseY - bh, 0, baseY);
      barG.addColorStop(0, topMonth ? rgba(P.amber, 0.95) : rgba(P.accent, 0.9));
      barG.addColorStop(1, topMonth ? rgba(P.amber, 0.35) : rgba(P.accent, 0.26));
      ctx.fillStyle = barG;
    } else {
      ctx.fillStyle = topMonth ? P.amber : P.accent;
    }
    if (bh > 0) {
      roundRectPath(ctx, bx, baseY - bh, bw, bh, Math.min(9, bw / 3));
      ctx.fill();
    }
    ctx.fillStyle = topMonth ? (highContrast ? P.text : P.amber) : P.faint;
    ctx.font = `${topMonth ? '700' : '500'} ${Math.max(13, Math.round(bw * 0.31))}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, monthLabel(m.month, lang), bw + 8), bx + bw / 2, baseY + 27);
  });

  const topText = r.topMonth
    ? t('trips.footprintTopMonth', {
      month: monthLabel(r.topMonth.month, lang),
      trips: r.topMonth.trips,
      distance: (() => {
        const d = fmtDistance(r.topMonth.distance, get('units'));
        return `${d.v}${d.u}`;
      })()
    })
    : t('trips.footprintEmptyYear');
  ctx.textAlign = 'left';
  ctx.fillStyle = P.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(fitText(ctx, topText, w - 76), x + 38, y + h - 28);
  ctx.restore();
}

function drawFooter(ctx: CanvasRenderingContext2D, P, highContrast: boolean, x, y, w, qrSize) {
  if (highContrast) {
    roundRectPath(ctx, x, y, w, qrSize + 38, 22);
    ctx.fillStyle = P.accent;
    ctx.fill();
    drawQr(ctx, SITE_URL, x + 22, y + 19, qrSize);
    const tx = x + 22 + qrSize + 28;
    ctx.textAlign = 'left';
    ctx.fillStyle = P.panel;
    ctx.font = `800 31px ${FONT}`;
    ctx.fillText(t('trips.footprintCta'), tx, y + 66);
    ctx.font = `600 23px ${SPORT_FONT}`;
    ctx.fillText(SITE_URL, tx, y + 106);
    ctx.font = `500 19px ${FONT}`;
    ctx.fillText(t('app.brandLine'), tx, y + 140);
    return;
  }

  const line = ctx.createLinearGradient(x, 0, x + w, 0);
  line.addColorStop(0, rgba(P.accent, 0.55));
  line.addColorStop(1, rgba(P.accent, 0));
  ctx.fillStyle = line;
  ctx.fillRect(x, y - 18, w, 1.5);
  drawQr(ctx, SITE_URL, x, y, qrSize);
  const tx = x + qrSize + 30;
  ctx.textAlign = 'left';
  ctx.fillStyle = P.text;
  ctx.font = `800 31px ${FONT}`;
  ctx.fillText(t('trips.footprintCta'), tx, y + 47);
  ctx.fillStyle = P.accent;
  ctx.font = `600 23px ${SPORT_FONT}`;
  ctx.fillText(SITE_URL, tx, y + 87);
  ctx.fillStyle = P.muted;
  ctx.font = `500 19px ${FONT}`;
  ctx.fillText(t('app.brandLine'), tx, y + 121);
}

function drawPrivacy(ctx: CanvasRenderingContext2D, P, w, y) {
  ctx.textAlign = 'center';
  ctx.fillStyle = P.faint;
  ctx.font = `500 18px ${FONT}`;
  ctx.fillText(t('trips.footprintPrivacy'), w / 2, y);
}

async function prepareFootprintMap(fp, w, h) {
  const cities = (fp.cities || []).slice(0, 40);
  if (!cities.length) return null;
  return prepareMap({
    w, h, pad: 50, maxZoom: 10,
    segments: [{ id: 'cities', points: cities.map((city) => ({ lat: city.lat, lon: city.lon })) }],
    waypoints: []
  });
}

function drawCityMap(ctx, fp, P, highContrast, map, x, y, w, h, reveal = 1, elapsedMs = 0) {
  const cities = (fp.cities || []).slice(0, 12);
  ctx.save();
  roundRectPath(ctx, x, y, w, h, 30);
  ctx.clip();
  if (map) ctx.drawImage(map.bg, x, y, w, h);
  else {
    ctx.fillStyle = P.vectorBg;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = P.grid;
    ctx.lineWidth = 1;
    for (let gx = x + 36; gx < x + w; gx += 72) {
      ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke();
    }
    for (let gy = y + 36; gy < y + h; gy += 72) {
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + w, gy); ctx.stroke();
    }
  }
  const shade = ctx.createLinearGradient(0, y, 0, y + 100);
  shade.addColorStop(0, highContrast ? 'rgba(255,255,255,.88)' : 'rgba(0,0,0,.34)');
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(x, y, w, 100);
  ctx.textAlign = 'left';
  ctx.fillStyle = highContrast ? P.text : '#ffffff';
  ctx.font = `700 25px ${FONT}`;
  ctx.fillText(t('trips.footprintCityMap'), x + 28, y + 42);
  ctx.font = `600 18px ${FONT}`;
  ctx.fillStyle = highContrast ? P.muted : 'rgba(255,255,255,.82)';
  ctx.fillText(t('trips.footprintCities', { n: fp.cities?.length || 0 }), x + 28, y + 70);

  if (!cities.length) {
    ctx.textAlign = 'center';
    ctx.fillStyle = P.muted;
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText(t('trips.footprintCityEmpty'), x + w / 2, y + h / 2 + 10);
    ctx.restore();
    return;
  }
  const maxTrips = Math.max(1, ...cities.map((city) => city.trips || 1));
  const displayCities = map?.segments?.[0]?.points || [];
  cities.forEach((city, i) => {
    const local = easeOut(clamp01(reveal * 1.45 - i * 0.07));
    if (local <= 0 || !map?.fit) return;
    const [px, py] = map.fit.toPx(displayCities[i] || city);
    const cx = x + px, cy = y + py;
    const radius = 8 + Math.round((city.trips / maxTrips) * 6);
    const pulse = ((elapsedMs / 1300) + i * 0.17) % 1;
    ctx.globalAlpha = local;
    ctx.strokeStyle = highContrast ? P.accent : 'rgba(255,255,255,.85)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, radius + 7 + pulse * 13, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = P.accent;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = P.panel;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = `700 17px ${FONT}`;
    const label = fitText(ctx, city.name, 150);
    const lw = ctx.measureText(label).width;
    const lx = Math.max(x + 8, Math.min(x + w - lw - 16, cx + radius + 8));
    const ly = Math.max(y + 86, Math.min(y + h - 14, cy + 6));
    ctx.fillStyle = highContrast ? 'rgba(255,255,255,.92)' : 'rgba(0,0,0,.58)';
    roundRectPath(ctx, lx - 6, ly - 18, lw + 12, 26, 7);
    ctx.fill();
    ctx.fillStyle = highContrast ? P.text : '#ffffff';
    ctx.fillText(label, lx, ly);
  });
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawImageScene(ctx, fp, P, highContrast, cityMap) {
  const lang = currentLang();
  const r = recapFootprint(fp, get('units'));
  drawBackground(ctx, P, highContrast, IMG_W, IMG_H);
  drawHeader(ctx, P, highContrast, r.year);
  drawHero(ctx, P, highContrast, r, 214);
  drawKpiCard(ctx, P, highContrast, r, M, 506, IMG_W - M * 2, 184);
  drawCityMap(ctx, fp, P, highContrast, cityMap, M, 722, IMG_W - M * 2, 390, 1);
  drawMonthCard(ctx, P, highContrast, fp, r, M, 1132, IMG_W - M * 2, 290, 1, lang);
  drawFooter(ctx, P, highContrast, M, 1432, IMG_W - M * 2, 100);
  drawPrivacy(ctx, P, IMG_W, 1604);
}

export async function generateFootprintImage(fp): Promise<{ blob: Blob; filename: string }> {
  await loadBrandFonts();
  const canvas = document.createElement('canvas');
  canvas.width = IMG_W;
  canvas.height = IMG_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D unavailable');
  const cityMap = await prepareFootprintMap(fp, IMG_W - M * 2, 390);
  drawImageScene(ctx, fp, canvasPalette(), document.documentElement.dataset.theme === 'contrast', cityMap);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
  return { blob, filename: `roametch-footprint-${fp.year}-${Date.now()}.png` };
}

function drawVideoScene(ctx, fp, P, highContrast, elapsedMs, cityMap) {
  const u = clamp01(elapsedMs / VIDEO_MS);
  const intro = easeOut(Math.min(1, elapsedMs / 800));
  const counters = easeOut(Math.max(0, (elapsedMs - 500) / 3600));
  const lang = currentLang();
  const r = recapFootprint(fp, get('units'));
  drawBackground(ctx, P, highContrast, VID_W, VID_H, elapsedMs / 1200);
  drawHeader(ctx, P, highContrast, r.year);
  drawHero(ctx, P, highContrast, r, 272, intro);

  const counted = {
    ...r,
    distance: (() => {
      const d = fmtDistance(fp.distance * counters, get('units'));
      return d;
    })(),
    ascent: (() => {
      const a = fmtAltitude(fp.ascent * counters, get('units'));
      return a;
    })(),
    trips: Math.round(r.trips * counters),
    days: Math.round(r.days * counters)
  };
  drawKpiCard(ctx, P, highContrast, counted, M, 650, VID_W - M * 2, 226, easeOut(Math.min(1, Math.max(0, (elapsedMs - 300) / 700))));
  drawCityMap(ctx, fp, P, highContrast, cityMap, M, 910, VID_W - M * 2, 380, easeOut(Math.max(0, (elapsedMs - 500) / 1200)), elapsedMs);
  drawMonthCard(ctx, P, highContrast, fp, r, M, 1310, VID_W - M * 2, 270, easeOut(Math.max(0, (elapsedMs - 900) / 1600)), lang);

  const footerA = easeOut(Math.max(0, (elapsedMs - 5200) / 900));
  ctx.save();
  ctx.globalAlpha = footerA;
  drawFooter(ctx, P, highContrast, M, 1620, VID_W - M * 2, 150);
  drawPrivacy(ctx, P, VID_W, 1830);
  ctx.restore();

  if (u < 0.12) {
    ctx.save();
    ctx.globalAlpha = 1 - easeOut(u / 0.12);
    ctx.fillStyle = P.panel;
    ctx.fillRect(0, 0, VID_W, VID_H);
    drawBrandMark(ctx, VID_W / 2 - 52, VID_H / 2 - 112, 104);
    ctx.textAlign = 'center';
    ctx.fillStyle = P.accent;
    ctx.font = `700 27px ${SPORT_FONT}`;
    ctx.fillText(t('trips.footprintVideoIntro', { year: r.year }), VID_W / 2, VID_H / 2 + 54);
    ctx.restore();
  }
}

export async function generateFootprintVideo(fp, { music = MUSIC_PREF_RANDOM, signal = null, onProgress = null } = {}): Promise<any> {
  if (!videoSupported()) throw new Error('video-unsupported');
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const musicSession = createMusicSession(music);
  let abort = null;
  try {
    await loadBrandFonts();
    const cityMap = await prepareFootprintMap(fp, VID_W - M * 2, 380);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    onProgress?.(0.05);
    const P = canvasPalette();
    const highContrast = document.documentElement.dataset.theme === 'contrast';
    const canvas = document.createElement('canvas');
    canvas.width = VID_W;
    canvas.height = VID_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D unavailable');

    let audioTrack = null;
    if (musicSession) {
      try { audioTrack = await musicSession.attach(VIDEO_MS); }
      catch (e) { console.warn('footprint music unavailable', e); }
    }
    const canvasStream = canvas.captureStream(30);
    const stream = audioTrack
      ? new MediaStream([...canvasStream.getVideoTracks(), audioTrack])
      : canvasStream;
    const rec = makeVideoRecorder(stream, !!audioTrack);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>((res) => { rec.onstop = () => res(); });
    abort = () => {
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
      stream.getTracks().forEach((tr) => tr.stop());
    };
    signal?.addEventListener('abort', abort, { once: true });
    rec.start(250);

    drawVideoScene(ctx, fp, P, highContrast, VIDEO_MS, cityMap);
    let cover = '';
    try { cover = canvas.toDataURL('image/jpeg', 0.82); } catch { /* ignore encode failure */ }

    await new Promise<void>((resolve, reject) => {
      const t0 = performance.now();
      const step = (now) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const elapsed = now - t0;
        drawVideoScene(ctx, fp, P, highContrast, Math.min(VIDEO_MS, elapsed), cityMap);
        onProgress?.(0.05 + 0.95 * Math.min(1, elapsed / VIDEO_MS));
        if (elapsed >= VIDEO_MS) { resolve(); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    try { rec.stop(); } catch { /* already stopped */ }
    stream.getTracks().forEach((tr) => tr.stop());
    await stopped;
    const type = (rec.mimeType || 'video/webm').split(';')[0];
    return {
      blob: new Blob(chunks, { type }),
      mime: type,
      width: VID_W,
      height: VID_H,
      seconds: VIDEO_MS / 1000,
      cover,
      musicTrack: audioTrack ? musicSession.track.id : null
    };
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    abort?.();
    musicSession?.stop();
  }
}
