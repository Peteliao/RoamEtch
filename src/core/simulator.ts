// Debug GPX playback simulator [v1.4]: feeds synthetic fixes through the real
// recorder pipeline (filters, segmentation, persistence all exercised).
import { parseGPX } from './gpx';
import { startRecording, stopRecording, handleFix, rec } from './recorder';
import { haversine, bearing } from './geo';
import { get } from './settings';
import { emit } from './events';
import { t } from './i18n';

let timer = null;
let playing = false;

/** Built-in demo: a mountain loop near Beijing Xiangshan (GCJ-02 demo friendly). */
export function builtinDemoGPX() {
  const pts = [];
  const N = 360;
  const cx = 116.185, cy = 39.995;
  const t0 = Date.now() - N * 15000;
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * Math.PI * 2;
    const r = 0.011 + 0.004 * Math.sin(th * 3 + 0.7) + 0.0015 * Math.sin(th * 7);
    const lon = cx + r * Math.cos(th) * 1.3;
    const lat = cy + r * Math.sin(th);
    const alt = 120 + 400 * (0.5 + 0.5 * Math.sin(th * 2 - 0.9)) + 12 * Math.sin(th * 11);
    pts.push({ lat, lon, alt: Math.round(alt * 10) / 10, t: t0 + i * 15000 });
  }
  return pts;
}

export function isPlaying() { return playing; }

export async function startPlayback({ gpxText = null, name = null } = {}) {
  if (playing) return false;
  let points;
  if (gpxText) {
    const parsed = parseGPX(gpxText);
    points = parsed.segments.flat();
    if (!points.length) throw new Error('empty gpx');
    if (!points.some((p) => p.t)) {
      const t0 = Date.now();
      points.forEach((p, i) => { p.t = t0 + i * 10000; });
    }
  } else {
    points = builtinDemoGPX();
  }
  const ok = await startRecording({ simulated: true, name: name || `${t('record.simRecording')} ${new Date().toLocaleTimeString()}` });
  if (!ok) return false;
  playing = true;
  emit('sim:started', { count: points.length });
  const speed = Math.max(1, get('sim').playbackSpeed || 20);
  const baseT = points[0].t;
  const wall0 = Date.now();
  let i = 0;
  const feedNext = () => {
    if (!playing || i >= points.length) {
      if (playing) finishPlayback();
      return;
    }
    const p = points[i];
    const prev = points[i - 1];
    let spd = null, hdg = null;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0) spd = d / dt;
      hdg = bearing(prev.lat, prev.lon, p.lat, p.lon);
    }
    handleFix({
      lat: p.lat, lon: p.lon, acc: 6 + Math.random() * 6,
      alt: p.alt ?? null, altAcc: p.alt != null ? 8 : null,
      speed: spd, heading: hdg, t: wall0 + (p.t - baseT)
    });
    emit('sim:progress', { i: i + 1, total: points.length });
    i++;
    const nextDelay = i < points.length
      ? Math.max(16, (points[i].t - p.t) / speed)
      : 500;
    timer = setTimeout(feedNext, nextDelay);
  };
  timer = setTimeout(feedNext, 300);
  return true;
}

export async function finishPlayback() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!playing) return;
  playing = false;
  await stopRecording();
  emit('sim:stopped');
}

export function stopPlayback() { return finishPlayback(); }