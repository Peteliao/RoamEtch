// Re-walk navigation: follow a reference trip forwards or backwards, join it
// midway, or get guided to an endpoint when off route. Live GPS drives a small
// phase machine — locating → approach → follow → finished.
import { loadTripFull } from './store';
import { haversine, bearing, fmtDistance } from './geo';
import { emit } from './events';
import { t, currentLang } from './i18n';
import { get, set } from './settings';
import { rec } from './recorder';

const ARRIVE_M = 60;
const NEAR_M = 150;
const OFF_M = 60;
const JOIN_M = 150;           // snap onto the track within this distance
const TARGET_ARRIVE_M = 35;   // reached the route start / selected endpoint
const FOLLOW_WINDOW = 600;    // keep nearest-point search local once following

export type RewalkMode = 'full-fwd' | 'full-rev' | 'near-end' | 'near-start';
export type RewalkPhase = 'locating' | 'approach' | 'follow' | 'finished';

const MODE_KEYS: Record<RewalkMode, string> = {
  'full-fwd': 'modeFullFwd',
  'full-rev': 'modeFullRev',
  'near-end': 'modeToEnd',
  'near-start': 'modeToStart'
};

export const rewalk = {
  active: false, tripId: null, name: '', mode: 'full-fwd' as RewalkMode,
  pts: [], cum: [], total: 0,
  idx: 0, maxIdx: 0, entryIdx: 0, entryAlong: 0, offTrack: 0,
  phase: 'locating' as RewalkPhase,
  targetType: 'end' as 'start' | 'end',
  navTarget: null as null | { lat: number; lon: number },
  navTargetType: null as null | 'start' | 'end',
  lastFix: null as null | { lat: number; lon: number; acc: any; heading: any },
  finished: false, departed: false, muted: false, sim: false, wps: [],
  announced: new Set(), nearAnnounced: new Set(),
  watchId: null, simTimer: null, simPos: null as null | { lat: number; lon: number },
  simDist: 0, lastOffAnnounce: 0
};

let speechPrimed = false;

// iOS only allows speechSynthesis.speak inside a user gesture. startRewalk runs
// synchronously up to its first await, so the tap that starts the walk can unlock
// voice for the GPS callbacks that speak later.
export function primeSpeech() {
  if (speechPrimed || !('speechSynthesis' in window)) return;
  speechPrimed = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    u.rate = 2;
    speechSynthesis.speak(u);
  } catch { /* speech unsupported */ }
}

export function speak(text) {
  if (rewalk.muted || get('rewalkVoice') === false || !text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  const zh = String(currentLang()).toLowerCase().startsWith('zh');
  u.lang = zh ? 'zh-CN' : 'en-US';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(zh ? 'zh' : 'en'));
  if (voice) u.voice = voice;
  u.rate = 1.05;
  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(u);
  } catch { /* speech interrupted */ }
}

function nearestIdx(lat, lon, pts = rewalk.pts, hint = -1) {
  let from = 0, to = pts.length - 1;
  if (hint >= 0 && pts.length > FOLLOW_WINDOW * 2) {
    from = Math.max(0, hint - FOLLOW_WINDOW);
    to = Math.min(pts.length - 1, hint + FOLLOW_WINDOW);
  }
  let best = from, bestD = Infinity;
  for (let i = from; i <= to; i++) {
    const p = pts[i];
    const d = haversine(lat, lon, p.lat, p.lon);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { idx: best, dist: bestD };
}

function wpLabel(w) {
  return t(`wp.types.${w.type}`) || w.type;
}

function approachLabel() {
  const type = rewalk.mode === 'full-fwd' ? 'start' : rewalk.mode === 'full-rev' ? 'end' : rewalk.targetType;
  return t(type === 'start' ? 'wp.types.start' : 'wp.types.end');
}

function distText(m) {
  const d = fmtDistance(m, get('units'));
  return `${d.v} ${d.u}`;
}

export async function startRewalk(tripId, mode: RewalkMode = 'full-fwd') {
  primeSpeech();
  if (rec.status === 'recording' || rec.status === 'paused') return 'busy';
  if (rewalk.active) stopRewalk();
  if (!MODE_KEYS[mode]) mode = 'full-fwd';
  const full = await loadTripFull(tripId);
  const orig = full?.segments.flatMap((s) => s.points) || [];
  if (orig.length < 2) return 'empty';

  const reverse = mode === 'full-rev' || mode === 'near-start';
  const pts = reverse ? orig.slice().reverse() : orig.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const total = cum[cum.length - 1];

  const origCum = [0];
  for (let i = 1; i < orig.length; i++) origCum.push(origCum[i - 1] + haversine(orig[i - 1].lat, orig[i - 1].lon, orig[i].lat, orig[i].lon));
  const wps = (full.waypoints || []).filter((w) => !w.hidden).map((w) => {
    const { idx } = nearestIdx(w.lat, w.lon, orig);
    const along = origCum[idx];
    return { ...w, distAlong: reverse ? total - along : along };
  });
  if (!wps.some((w) => w.type === 'start')) {
    wps.push({ id: '_start', type: 'start', name: t('wp.types.start'), desc: '', lat: orig[0].lat, lon: orig[0].lon, distAlong: reverse ? total : 0 });
  }
  if (!wps.some((w) => w.type === 'end')) {
    const last = orig[orig.length - 1];
    wps.push({ id: '_end', type: 'end', name: t('wp.types.end'), desc: '', lat: last.lat, lon: last.lon, distAlong: reverse ? 0 : total });
  }
  wps.sort((a, b) => a.distAlong - b.distAlong);

  Object.assign(rewalk, {
    active: true, tripId, name: full.trip.name || t('record.newTripName'), mode,
    pts, cum, total,
    idx: 0, maxIdx: 0, entryIdx: 0, entryAlong: 0, offTrack: 0,
    phase: 'locating' as RewalkPhase,
    targetType: (mode === 'full-rev' || mode === 'near-start') ? 'start' : 'end',
    navTarget: null, navTargetType: null, lastFix: null, simPos: null,
    finished: false, departed: false, muted: get('rewalkVoice') === false, wps,
    announced: new Set(), nearAnnounced: new Set(), simDist: 0, lastOffAnnounce: 0
  });
  emit('rewalk:started', {
    tripId, name: rewalk.name, total, mode, targetType: rewalk.targetType,
    segments: full.segments, waypoints: full.waypoints
  });
  speak(t('rewalk.voiceStart', { name: rewalk.name, mode: t(`rewalk.${MODE_KEYS[mode]}`) }));
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

function beginFollow(idx, announceJoin) {
  rewalk.phase = 'follow';
  rewalk.entryIdx = idx;
  rewalk.entryAlong = rewalk.cum[idx] || 0;
  rewalk.idx = idx;
  rewalk.maxIdx = idx;
  rewalk.offTrack = 0;
  rewalk.departed = false;
  rewalk.navTarget = null;
  rewalk.navTargetType = null;
  if (announceJoin) speak(t('rewalk.joinAnnounce'));
}

function beginApproach(target, fromLat, fromLon) {
  rewalk.phase = 'approach';
  rewalk.navTarget = { lat: target.lat, lon: target.lon };
  rewalk.navTargetType = rewalk.mode === 'full-fwd' ? 'start' : rewalk.mode === 'full-rev' ? 'end' : rewalk.targetType;
  const d = haversine(fromLat, fromLon, target.lat, target.lon);
  speak(t('rewalk.approachAnnounce', { target: approachLabel(), dist: distText(d) }));
}

function locate(lat, lon) {
  if (rewalk.mode === 'full-fwd' || rewalk.mode === 'full-rev') {
    const start = rewalk.pts[0];
    const d = haversine(lat, lon, start.lat, start.lon);
    if (d <= JOIN_M) beginFollow(0, false);
    else beginApproach(start, lat, lon);
    return;
  }
  const { idx, dist } = nearestIdx(lat, lon);
  if (dist <= JOIN_M) {
    beginFollow(idx, false);
  } else {
    const target = rewalk.pts[rewalk.pts.length - 1];
    beginApproach(target, lat, lon);
  }
}

function finish() {
  if (rewalk.finished) return;
  rewalk.finished = true;
  rewalk.phase = 'finished';
  stopWatch();
  stopSim();
  speak(t(rewalk.targetType === 'start' ? 'rewalk.voiceArriveStart' : 'rewalk.voiceArriveEnd'));
  emit('rewalk:finished', { total: rewalk.total, targetType: rewalk.targetType, mode: rewalk.mode });
}

function emission(lat, lon, acc, heading) {
  const along = rewalk.cum[rewalk.maxIdx] || 0;
  const span = Math.max(1e-6, rewalk.total - rewalk.entryAlong);
  const inFollow = rewalk.phase === 'follow' || rewalk.phase === 'finished';
  const progress = inFollow ? Math.max(0, Math.min(1, (along - rewalk.entryAlong) / span)) : 0;
  const target = rewalk.navTarget || rewalk.pts[rewalk.pts.length - 1];
  const remaining = rewalk.phase === 'approach'
    ? haversine(lat, lon, target.lat, target.lon)
    : Math.max(0, rewalk.total - along);
  const nextWp = rewalk.wps.find((w) => w.distAlong > along + 5) || null;
  emit('rewalk:fix', {
    idx: rewalk.idx, lat, lon, acc, heading, offTrack: rewalk.offTrack,
    progress, remaining, phase: rewalk.phase, mode: rewalk.mode,
    targetType: rewalk.targetType, navTargetType: rewalk.navTargetType,
    targetLat: target?.lat, targetLon: target?.lon,
    navDist: rewalk.phase === 'approach' ? remaining : null,
    navBearing: rewalk.phase === 'approach' ? bearing(lat, lon, target.lat, target.lon) : null,
    nextWp: nextWp ? { name: nextWp.name || wpLabel(nextWp), type: nextWp.type, dist: Math.max(0, nextWp.distAlong - along) } : null,
    finished: rewalk.finished
  });
}

/** Central fix pipeline — also fed by the walk simulator. */
export function feedFix(lat, lon, acc = null, heading = null) {
  if (!rewalk.active) return;
  rewalk.lastFix = { lat, lon, acc, heading };
  if (rewalk.phase === 'locating') locate(lat, lon);
  if (rewalk.phase === 'approach' && rewalk.navTarget) {
    const target = rewalk.navTarget;
    const d = haversine(lat, lon, target.lat, target.lon);
    if (d <= TARGET_ARRIVE_M) {
      if (rewalk.mode === 'full-fwd' || rewalk.mode === 'full-rev') beginFollow(0, true);
      else finish();
    }
    if (rewalk.phase === 'approach') { emission(lat, lon, acc, heading); return; }
    if (rewalk.phase === 'finished') { emission(lat, lon, acc, heading); return; }
  }
  if (rewalk.phase !== 'follow') return;

  const { idx, dist } = nearestIdx(lat, lon, rewalk.pts, rewalk.idx);
  rewalk.idx = idx;
  rewalk.maxIdx = Math.max(rewalk.maxIdx, idx);
  rewalk.offTrack = dist;
  const along = rewalk.cum[rewalk.maxIdx];

  for (const w of rewalk.wps) {
    if (w.distAlong < along - 30) continue;
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

  const entry = rewalk.pts[rewalk.entryIdx];
  if (!rewalk.departed && entry && haversine(lat, lon, entry.lat, entry.lon) > 100) rewalk.departed = true;
  const last = rewalk.pts[rewalk.pts.length - 1];
  const atTarget = haversine(lat, lon, last.lat, last.lon) < 40;
  // A loop can pass the endpoint repeatedly; only count arrival after the
  // walker has actually left the entry vicinity (or followed to the last point).
  if (!rewalk.finished && atTarget && (rewalk.departed || rewalk.maxIdx >= rewalk.pts.length - 2)) {
    finish();
  }
  emission(lat, lon, acc, heading);
}

export function stopRewalk() {
  if (!rewalk.active) return;
  stopWatch();
  stopSim();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  rewalk.active = false;
  rewalk.finished = false;
  rewalk.navTarget = null;
  rewalk.simPos = null;
  rewalk.lastFix = null;
  emit('rewalk:stopped', {});
}

export function setRewalkVoice(on: boolean) {
  const enabled = !!on;
  set('rewalkVoice', enabled);
  rewalk.muted = !enabled;
  if (!enabled && 'speechSynthesis' in window) speechSynthesis.cancel();
  if (enabled) primeSpeech();
  emit('rewalk:mute', { muted: rewalk.muted });
}

export function toggleMute() {
  setRewalkVoice(rewalk.muted);
  return rewalk.muted;
}

function moveToward(lat, lon, brg, dist) {
  const R = 6371008.8;
  const d = dist / R, th = (brg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180, l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
}

export function startSim() {
  if (!rewalk.active || rewalk.sim) return;
  rewalk.sim = true;
  if (rewalk.phase === 'locating') {
    const seedIdx = rewalk.mode === 'full-fwd' || rewalk.mode === 'full-rev'
      ? 0
      : Math.floor((rewalk.pts.length - 1) / 2);
    const p = rewalk.pts[seedIdx];
    feedFix(p.lat, p.lon, 5, null);
  }
  if (rewalk.phase === 'approach' && rewalk.navTarget) {
    const from = rewalk.lastFix || rewalk.navTarget;
    rewalk.simPos = { lat: from.lat, lon: from.lon };
  }
  rewalk.simDist = rewalk.cum[rewalk.maxIdx] || 0;
  rewalk.simTimer = setInterval(() => {
    if (!rewalk.active || rewalk.phase === 'finished') { stopSim(); return; }
    if (rewalk.phase === 'approach' && rewalk.navTarget) {
      const target = rewalk.navTarget;
      const pos = rewalk.simPos || target;
      const d = haversine(pos.lat, pos.lon, target.lat, target.lon);
      if (d <= 8) {
        feedFix(target.lat, target.lon, 5, null);
      } else {
        const brg = bearing(pos.lat, pos.lon, target.lat, target.lon);
        const p = moveToward(pos.lat, pos.lon, brg, Math.min(15, d));
        rewalk.simPos = p;
        feedFix(p.lat, p.lon, 5, brg);
      }
      return;
    }
    if (rewalk.phase === 'follow') {
      rewalk.simDist = Math.max(rewalk.simDist, rewalk.cum[rewalk.maxIdx] || 0) + 8;
      if (rewalk.simDist >= rewalk.total) {
        const last = rewalk.pts[rewalk.pts.length - 1];
        stopSim();
        feedFix(last.lat, last.lon, 5, null);
        return;
      }
      let i = rewalk.idx;
      while (i < rewalk.cum.length - 1 && rewalk.cum[i + 1] < rewalk.simDist) i++;
      const p = rewalk.pts[i], n = rewalk.pts[Math.min(i + 1, rewalk.pts.length - 1)];
      feedFix(p.lat, p.lon, 5, bearing(p.lat, p.lon, n.lat, n.lon));
    }
  }, 400);
  emit('rewalk:sim', { on: true });
}
export function stopSim() {
  if (rewalk.simTimer) { clearInterval(rewalk.simTimer); rewalk.simTimer = null; }
  if (rewalk.sim) { rewalk.sim = false; emit('rewalk:sim', { on: false }); }
}
