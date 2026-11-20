// Re-walk mode: follow a reference trip along-track with live GPS, off-track
// detection and voice announcements of waypoints (type + name + description).
import { loadTripFull } from './store';
import { haversine, bearing, fmtDistance } from './geo';
import { emit } from './events';
import { t, currentLang } from './i18n';
import { get } from './settings';
import { rec } from './recorder';

const ARRIVE_M = 60;
const NEAR_M = 150;
const OFF_M = 60;

export const rewalk = {
  active: false, tripId: null, name: '', pts: [], cum: [], total: 0,
  idx: 0, maxIdx: 0, offTrack: 0, finished: false,
  muted: false, sim: false, wps: [],
  announced: new Set(), nearAnnounced: new Set(),
  watchId: null, simTimer: null, simDist: 0, lastOffAnnounce: 0
};

export function speak(text) {
  if (rewalk.muted || !text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const zh = String(currentLang()).toLowerCase().startsWith('zh');
  u.lang = zh ? 'zh-CN' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(zh ? 'zh' : 'en'));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

function nearestIdx(lat, lon, pts = rewalk.pts) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { idx: best, dist: bestD };
}

function wpLabel(w) {
  return t(`wp.types.${w.type}`) || w.type;
}

export async function startRewalk(tripId) {
  if (rec.status === 'recording' || rec.status === 'paused') return 'busy';
  if (rewalk.active) stopRewalk();
  const full = await loadTripFull(tripId);
  const pts = full?.segments.flatMap((s) => s.points) || [];
  if (pts.length < 2) return 'empty';
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const total = cum[cum.length - 1];
  const wps = (full.waypoints || []).filter((w) => !w.hidden).map((w) => {
    const { idx } = nearestIdx(w.lat, w.lon, pts);
    return { ...w, distAlong: cum[idx] };
  });
  if (!wps.some((w) => w.type === 'start')) wps.push({ id: '_start', type: 'start', name: t('wp.types.start'), desc: '', lat: pts[0].lat, lon: pts[0].lon, distAlong: 0 });
  if (!wps.some((w) => w.type === 'end')) wps.push({ id: '_end', type: 'end', name: t('wp.types.end'), desc: '', lat: pts[pts.length - 1].lat, lon: pts[pts.length - 1].lon, distAlong: total });
  wps.sort((a, b) => a.distAlong - b.distAlong);

  Object.assign(rewalk, {
    active: true, tripId, name: full.trip.name || t('record.newTripName'), pts, cum, total,
    idx: 0, maxIdx: 0, offTrack: 0, finished: false, wps,
    announced: new Set(), nearAnnounced: new Set(), simDist: 0, lastOffAnnounce: 0
  });
  emit('rewalk:started', { tripId, name: rewalk.name, total, segments: full.segments, waypoints: full.waypoints });
  const d = fmtDistance(total, get('units'));
  speak(t('rewalk.startAnnounce', { name: rewalk.name, dist: `${d.v}${d.u}` }));
  startWatch();
  return true;
}

function startWatch() {
  if (!navigator.geolocation) return;
  rewalk.watchId = navigator.geolocation.watchPosition(
    (pos) => feedFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading),
    (err) => emit('rewalk:geoerror', { code: err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'timeout' }),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}
function stopWatch() {
  if (rewalk.watchId != null) { navigator.geolocation?.clearWatch(rewalk.watchId); rewalk.watchId = null; }
}

/** Central fix pipeline — also fed by the walk simulator. */
export function feedFix(lat, lon, acc = null, heading = null) {
  if (!rewalk.active) return;
  const { idx, dist } = nearestIdx(lat, lon);
  rewalk.idx = idx;
  rewalk.maxIdx = Math.max(rewalk.maxIdx, idx);
  rewalk.offTrack = dist;
  const along = rewalk.cum[rewalk.maxIdx];
  const nextWp = rewalk.wps.find((w) => w.distAlong > along + 5) || null;

  for (const w of rewalk.wps) {
    const d = haversine(lat, lon, w.lat, w.lon);
    const label = wpLabel(w);
    const named = w.name && w.name !== label;
    if (d <= ARRIVE_M && !rewalk.announced.has(w.id)) {
      rewalk.announced.add(w.id);
      speak(t(named ? 'rewalk.wpAnnounce' : 'rewalk.wpAnnounceSolo', { type: label, name: w.name || label, desc: w.desc || '' }));
    } else if (d <= NEAR_M && !rewalk.nearAnnounced.has(w.id) && !rewalk.announced.has(w.id)) {
      rewalk.nearAnnounced.add(w.id);
      speak(t(named ? 'rewalk.nearAnnounce' : 'rewalk.nearAnnounceSolo', { m: Math.round(d), type: label, name: w.name || label }));
    }
  }
  if (dist > OFF_M && Date.now() - rewalk.lastOffAnnounce > 30000) {
    rewalk.lastOffAnnounce = Date.now();
    speak(t('rewalk.offAnnounce'));
  }

  const last = rewalk.pts[rewalk.pts.length - 1];
  if (!rewalk.finished && rewalk.maxIdx >= rewalk.pts.length - 2 && haversine(lat, lon, last.lat, last.lon) < 40) {
    rewalk.finished = true;
    stopWatch();
    stopSim();
    speak(t('rewalk.endAnnounce'));
    emit('rewalk:finished', { total: rewalk.total });
  }
  emit('rewalk:fix', {
    idx, lat, lon, acc, heading, offTrack: dist,
    progress: rewalk.total ? along / rewalk.total : 0,
    remaining: Math.max(0, rewalk.total - along),
    nextWp: nextWp ? { name: nextWp.name, type: nextWp.type, dist: Math.max(0, nextWp.distAlong - along) } : null,
    finished: rewalk.finished
  });
}

export function stopRewalk() {
  if (!rewalk.active) return;
  stopWatch();
  stopSim();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  rewalk.active = false;
  rewalk.finished = false;
  emit('rewalk:stopped', {});
}

export function toggleMute() {
  rewalk.muted = !rewalk.muted;
  if (rewalk.muted && 'speechSynthesis' in window) speechSynthesis.cancel();
  emit('rewalk:mute', { muted: rewalk.muted });
  return rewalk.muted;
}

export function startSim() {
  if (!rewalk.active || rewalk.sim) return;
  rewalk.sim = true;
  rewalk.simDist = rewalk.cum[rewalk.maxIdx];
  rewalk.simTimer = setInterval(() => {
    rewalk.simDist += 8;
    if (rewalk.simDist >= rewalk.total) { stopSim(); feedFix(rewalk.pts[rewalk.pts.length - 1].lat, rewalk.pts[rewalk.pts.length - 1].lon, 5, null); return; }
    let i = rewalk.idx;
    while (i < rewalk.cum.length - 1 && rewalk.cum[i + 1] < rewalk.simDist) i++;
    const p = rewalk.pts[i], n = rewalk.pts[Math.min(i + 1, rewalk.pts.length - 1)];
    feedFix(p.lat, p.lon, 5, bearing(p.lat, p.lon, n.lat, n.lon));
  }, 400);
  emit('rewalk:sim', { on: true });
}
export function stopSim() {
  if (rewalk.simTimer) { clearInterval(rewalk.simTimer); rewalk.simTimer = null; }
  if (rewalk.sim) { rewalk.sim = false; emit('rewalk:sim', { on: false }); }
}