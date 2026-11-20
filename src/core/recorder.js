// GPS recording engine: validation filters, gap segmentation, incremental persistence,
// incremental live stats. Storage is always WGS-84 regardless of region profile.
import { get } from './settings.js';
import { emit } from './events.js';
import { t } from './i18n.js';
import { haversine, uuid } from './geo.js';
import * as store from './store.js';
import { resolveAltitude } from './elevation.js';
import { acquireRecorderLock, releaseRecorderLock, broadcast, isHolding } from './locks.js';
import { requestWakeLock, releaseWakeLock } from './wakelock.js';
import { classifyActivity } from './activity.js';

const GAP_TIME = 5 * 60_000;   // > 5 min → new segment
const GAP_DIST = 500;          // > 500 m jump → new segment
const NOISE_DIST = 2;          // metres
const MOVING_SPEED = 0.5;      // m/s
const FLUSH_POINTS = 10;
const FLUSH_MS = 5000;
const ALT_WAIT = 1200;         // ms to wait for elevation before appending null
const SILENT_MS = 20_000;      // no fix callback at all → location likely switched off
const BG_NOTICE_MS = 15_000;   // background absence worth notifying about

const MAX_SPEED = { hike: 7, run: 12.5, bike: 22, drive: 70, travel: 70 }; // m/s

export const rec = {
  status: 'idle',              // idle | recording | paused | finished
  tripId: null,
  segmentId: null,
  simulated: false,
  permissionDenied: false,
  geoError: null,              // denied | unavailable | timeout | silent | null
  activityGuess: null,         // live classification while trip.activity === 'auto'
  filteredCount: 0,
  live: null,
  lastPoint: null,
  lastFixT: 0,
  lastFixWall: 0,
  firstFixT: 0,
  startedAt: 0
};

let watchId = null;
let buffer = [];
let flushTimer = null;
let tickTimer = null;
let altSmooth = null;
let altRef = null;
let pausedAt = 0;
let hiddenAt = 0;
let speedSamples = [];

function freshLive() {
  return {
    distance: 0, ascent: 0, descent: 0, movingMs: 0, stillMs: 0, duration: 0,
    speed: null, alt: null, altSrc: null, slope: null, acc: null,
    lat: null, lon: null, heading: null, pointCount: 0, segCount: 0, maxSpeed: 0
  };
}

function watchOptions() {
  const q = get('recordQuality');
  if (q === 'high') return { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
  if (q === 'low') return { enableHighAccuracy: false, maximumAge: 10000, timeout: 30000 };
  return { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 };
}

export async function startRecording({ tripId = null, name = '', activity = null, simulated = false } = {}) {
  if (rec.status === 'recording') return true;
  if (!simulated && !(await acquireRecorderLock())) {
    emit('recorder:busy');
    return false;
  }
  rec.simulated = simulated;
  rec.filteredCount = 0;
  rec.permissionDenied = false;
  rec.geoError = null;
  rec.lastFixWall = Date.now();
  rec.activityGuess = null;
  speedSamples = [];
  let trip;
  if (tripId) {
    trip = await store.getTrip(tripId);
    if (!trip) return false;
  } else {
    trip = await store.createTrip({
      name: name || `${t('record.newTripName')} ${new Date().toLocaleString()}`,
      activity: activity || get('activity'),
      status: 'recording'
    });
  }
  rec.tripId = trip.id;
  rec.status = 'recording';
  rec.startedAt = Date.now();
  rec.live = freshLive();
  rec.lastPoint = null;
  rec.firstFixT = 0; rec.lastFixT = 0;
  altSmooth = null; altRef = null;
  buffer = [];

  const seg = await store.addSegment(trip.id);
  rec.segmentId = seg.id;
  rec.live.segCount = await store.db.segments.where('tripId').equals(trip.id).count();
  await store.updateTrip(trip.id, { status: 'recording' });

  if (!simulated) startWatch();
  requestWakeLock();
  startTick();
  broadcast({ type: 'rec-state', state: 'recording', tripId: trip.id });
  emit('recorder:started', { tripId: trip.id, simulated });
  return true;
}

function startWatch() {
  if (!navigator.geolocation) {
    rec.permissionDenied = true;
    rec.geoError = 'denied';
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    return;
  }
  stopWatch();
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      rec.lastFixWall = Date.now();
      if (rec.geoError && rec.geoError !== 'denied') {
        rec.geoError = null;
        emit('recorder:geoerror', { code: null });
      }
      handleFix({
        lat: pos.coords.latitude, lon: pos.coords.longitude,
        acc: pos.coords.accuracy, alt: pos.coords.altitude, altAcc: pos.coords.altitudeAccuracy,
        speed: pos.coords.speed, heading: pos.coords.heading, t: pos.timestamp || Date.now()
      });
    },
    (err) => {
      if (err.code === 1) {
        rec.permissionDenied = true;
        rec.geoError = 'denied';
        emit('recorder:geoerror', { code: 'denied' });
        emit('recorder:denied');
        pauseRecording();
      } else {
        // code 2 = OS location off / no source; code 3 = timeout (weak signal)
        rec.geoError = err.code === 2 ? 'unavailable' : 'timeout';
        emit('recorder:geoerror', { code: rec.geoError });
      }
    },
    watchOptions()
  );
}
function stopWatch() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

/** Re-arm the watch after a signal error (OS location switched back on, etc.). */
export function retryGeolocation() {
  if (rec.simulated || rec.status !== 'recording') return;
  rec.geoError = null;
  rec.lastFixWall = Date.now();
  startWatch();
  emit('recorder:geoerror', { code: null });
}

/** Central fix pipeline — also fed by the GPX simulator. */
export async function handleFix(fix) {
  if (rec.status !== 'recording') return;
  const now = fix.t || Date.now();
  rec.lastFixT = now;
  if (!rec.firstFixT) rec.firstFixT = now;
  const accLimit = get('accuracyLimit');
  const tripActivity = (await store.getTrip(rec.tripId))?.activity || get('activity');
  // auto: stay permissive (travel envelope) until the classifier converges
  const activity = tripActivity === 'auto' ? (rec.activityGuess || 'travel') : tripActivity;
  const vmax = MAX_SPEED[activity] ?? 7;

  // ---- filter: poor accuracy ----
  if (fix.acc != null && fix.acc > accLimit) {
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'accuracy', count: rec.filteredCount });
    return;
  }

  let dist = 0, dt = 0, implied = null;
  if (rec.lastPoint) {
    dist = haversine(rec.lastPoint.lat, rec.lastPoint.lon, fix.lat, fix.lon);
    dt = now - rec.lastPoint.t;
    if (dt > 0) implied = dist / (dt / 1000);
    // feed the auto-activity classifier even with fixes the filters reject
    if (dt > 0 && dt <= 60000) {
      const s = fix.speed != null && isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : implied;
      if (s != null && s > MOVING_SPEED) {
        speedSamples.push(s);
        if (speedSamples.length > 400) speedSamples.shift();
        if (tripActivity === 'auto' && speedSamples.length >= 6 && (!rec.activityGuess || speedSamples.length % 5 === 0)) {
          const guess = classifyActivity(speedSamples);
          if (guess && guess !== rec.activityGuess) {
            rec.activityGuess = guess;
            emit('activity:guess', { activity: guess });
          }
        }
      }
    }
    // ---- filter: teleport jump ----
    if (implied != null && implied > vmax && dist > 30) {
      rec.filteredCount++;
      emit('recorder:filtered', { reason: 'jump', count: rec.filteredCount });
      return;
    }
    // ---- stationary noise: don't grow the track ----
    if (dist < NOISE_DIST && (implied == null || implied < MOVING_SPEED)) {
      if (dt > 0 && dt <= 60000) rec.live.stillMs += dt;
      rec.live.speed = 0;
      emit('recorder:tick', { live: rec.live });
      return;
    }
    // ---- gap → new segment ----
    if (dt > GAP_TIME || dist > GAP_DIST) {
      await flushBuffer();
      const seg = await store.addSegment(rec.tripId, now);
      rec.segmentId = seg.id;
      rec.live.segCount++;
      rec.lastPoint = null;
      dist = 0; dt = 0; implied = null;
      emit('recorder:gap', { dist, dt });
      emit('toast', { type: 'warn', msg: t('record.gapNewSegment') });
    }
  }

  // ---- altitude priority chain ----
  let alt = null, altSrc = null, altPending = false;
  const altPromise = resolveAltitude(fix.lat, fix.lon, fix.alt, fix.altAcc);
  const raced = await Promise.race([
    altPromise,
    new Promise((res) => setTimeout(() => res({ alt: null, src: null, pending: true }), ALT_WAIT))
  ]);
  alt = raced.alt; altSrc = raced.src; altPending = !!raced.pending;

  const speed = fix.speed != null && isFinite(fix.speed) && fix.speed >= 0
    ? fix.speed
    : (implied != null && dt <= 60000 ? implied : null);

  const point = {
    lat: fix.lat, lon: fix.lon, t: now,
    alt, altSrc, acc: fix.acc ?? null,
    speed: speed != null ? Math.round(speed * 100) / 100 : null
  };

  // ---- incremental live stats ----
  const L = rec.live;
  L.distance += dist;
  if (dt > 0 && dt <= 60000) {
    if (speed != null && speed > MOVING_SPEED) L.movingMs += dt;
    else L.stillMs += dt;
  }
  L.speed = speed;
  L.acc = fix.acc ?? null;
  L.lat = fix.lat; L.lon = fix.lon;
  L.heading = fix.heading != null && isFinite(fix.heading) ? fix.heading : null;
  L.pointCount++;
  if (speed != null && speed > L.maxSpeed && speed < vmax * 1.5) L.maxSpeed = speed;
  if (alt != null) {
    altSmooth = altSmooth == null ? alt : 0.35 * alt + 0.65 * altSmooth;
    if (altRef == null) altRef = altSmooth;
    const d = altSmooth - altRef;
    const th = get('ascentThreshold');
    if (d >= th) { L.ascent += d; altRef = altSmooth; }
    else if (d <= -th) { L.descent += -d; altRef = altSmooth; }
    L.alt = alt; L.altSrc = altSrc;
  }
  // slope from recent buffer window
  const recent = [...buffer.slice(-6), point];
  if (recent.length > 1 && alt != null) {
    let j = recent.length - 2, dd = 0;
    while (j > 0 && dd < 30) { dd += haversine(recent[j].lat, recent[j].lon, recent[j + 1].lat, recent[j + 1].lon); j--; }
    const q = recent[j];
    if (q.alt != null && dd >= 5) L.slope = ((alt - q.alt) / dd) * 100;
  }

  rec.lastPoint = point;
  buffer.push(point);
  if (altPending) {
    altPromise.then((res) => {
      if (res.alt == null) return;
      point.alt = res.alt; point.altSrc = res.src;
      if (point._flushed) patchFlushedAlt(point);
      else {
        if (altSmooth == null) altSmooth = res.alt;
        L.alt = res.alt; L.altSrc = res.src;
        emit('recorder:tick', { live: L });
      }
    });
  }
  if (buffer.length >= FLUSH_POINTS) flushBuffer();
  else if (!flushTimer) flushTimer = setTimeout(flushBuffer, FLUSH_MS);

  emit('recorder:point', { point, live: L });
}

async function patchFlushedAlt(point) {
  try {
    const chunks = await store.db.trackChunks.where('segmentId').equals(point._segmentId).toArray();
    for (const c of chunks) {
      const p = c.points.find((x) => x.t === point.t);
      if (p) { p.alt = point.alt; p.altSrc = point.altSrc; await store.db.trackChunks.put(c); break; }
    }
  } catch { /* non-critical */ }
}

export async function flushBuffer() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!buffer.length || !rec.segmentId) return;
  const pts = buffer;
  buffer = [];
  const segId = rec.segmentId;
  pts.forEach((p) => { p._flushed = true; p._segmentId = segId; });
  try {
    await store.appendPoints(segId, rec.tripId, pts.map(stripInternal));
    emit('recorder:saved', { count: pts.length });
  } catch (e) {
    console.error('flush failed', e);
    buffer.unshift(...pts); // retry next cycle
  }
}
function stripInternal(p) {
  const { _flushed, _segmentId, ...rest } = p;
  return rest;
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    if (rec.status === 'recording' && rec.live) {
      rec.live.duration = rec.simulated && rec.firstFixT
        ? rec.lastFixT - rec.firstFixT
        : Date.now() - rec.startedAt;
      // some WebViews swallow the error callback when OS location is off
      if (!rec.simulated && !rec.geoError && Date.now() - (rec.lastFixWall || rec.startedAt) > SILENT_MS) {
        rec.geoError = 'silent';
        emit('recorder:geoerror', { code: 'silent' });
      }
      emit('recorder:tick', { live: rec.live });
    }
  }, 1000);
}
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

export async function pauseRecording() {
  if (rec.status !== 'recording') return;
  await flushBuffer();
  stopWatch();
  rec.status = 'paused';
  pausedAt = Date.now();
  await store.updateTrip(rec.tripId, { status: 'paused' });
  releaseWakeLock();
  broadcast({ type: 'rec-state', state: 'paused', tripId: rec.tripId });
  emit('recorder:paused', { tripId: rec.tripId });
}

export async function resumeRecording() {
  if (rec.status !== 'paused' || !rec.tripId) return false;
  if (!rec.simulated && !isHolding() && !(await acquireRecorderLock())) {
    emit('recorder:busy');
    return false;
  }
  // pause/resume always starts a fresh segment (no straight-line bridging)
  await flushBuffer();
  const seg = await store.addSegment(rec.tripId);
  rec.segmentId = seg.id;
  rec.lastPoint = null;
  rec.live.segCount++;
  rec.status = 'recording';
  rec.startedAt = Date.now() - (rec.live?.duration || 0);
  rec.permissionDenied = false;
  rec.geoError = null;
  rec.lastFixWall = Date.now();
  await store.updateTrip(rec.tripId, { status: 'recording' });
  if (!rec.simulated) startWatch();
  requestWakeLock();
  startTick();
  broadcast({ type: 'rec-state', state: 'recording', tripId: rec.tripId });
  emit('recorder:resumed', { tripId: rec.tripId });
  return true;
}

export async function stopRecording() {
  if (rec.status === 'idle' || rec.status === 'finished') return;
  await flushBuffer();
  stopWatch();
  stopTick();
  // pause/resume without fixes leaves empty segments — prune them at stop
  const full = await store.loadTripFull(rec.tripId);
  for (const s of full.segments) if (!s.points.length) await store.deleteSegment(s.id);
  rec.status = 'finished';
  if (rec.tripId) {
    const tr = await store.getTrip(rec.tripId);
    const finalActivity = tr?.activity === 'auto'
      ? (rec.activityGuess || classifyActivity(speedSamples) || 'hike')
      : null;
    await store.updateTrip(rec.tripId, finalActivity ? { status: 'finished', activity: finalActivity } : { status: 'finished' });
  }
  releaseWakeLock();
  releaseRecorderLock();
  broadcast({ type: 'rec-state', state: 'finished', tripId: rec.tripId });
  emit('recorder:stopped', { tripId: rec.tripId });
  const id = rec.tripId;
  rec.tripId = null; rec.segmentId = null; rec.live = null; rec.lastPoint = null;
  return id;
}

/** Continue an interrupted trip found at boot (new segment, no data loss). */
export async function continueTrip(tripId) {
  const trip = await store.getTrip(tripId);
  if (!trip) return false;
  if (!(await acquireRecorderLock())) { emit('recorder:busy'); return false; }
  rec.tripId = tripId;
  rec.status = 'paused';
  rec.simulated = false;
  rec.activityGuess = null;
  speedSamples = [];
  rec.live = freshLive();
  // rebuild live counters from stored data
  const full = await store.loadTripFull(tripId);
  const { computeStats } = await import('./stats.js');
  const st = computeStats(full.segments, { ascentThreshold: get('ascentThreshold') });
  Object.assign(rec.live, {
    distance: st.distance, ascent: st.ascent, descent: st.descent,
    movingMs: st.movingMs, stillMs: st.stillMs, duration: st.duration,
    pointCount: st.pointCount, segCount: st.segCount, maxSpeed: st.maxSpeed
  });
  const lastSeg = full.segments[full.segments.length - 1];
  const lastPt = lastSeg?.points[lastSeg.points.length - 1];
  if (lastPt) { rec.lastPoint = lastPt; altSmooth = lastPt.alt; altRef = lastPt.alt; }
  return resumeRecording();
}

/** Find trips left in recording/paused state (crash / kill recovery). */
export async function findRecoverableTrip() {
  const all = await store.listTrips();
  return all.find((tr) => tr.status === 'recording' || tr.status === 'paused') || null;
}

export async function createManualTrip(name) {
  const trip = await store.createTrip({ name: name || t('record.newTripName'), activity: get('activity'), status: 'paused' });
  await store.addSegment(trip.id);
  return trip;
}

// release lock if tab closes mid-recording (data already incrementally persisted)
window.addEventListener('pagehide', () => { flushBuffer(); });

// Backgrounding: flush immediately; on return, tell the UI about the absence so it
// can explain possible OS-level pauses (iOS suspends the page, Android throttles it).
document.addEventListener('visibilitychange', () => {
  if (rec.status !== 'recording' && rec.status !== 'paused') return;
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    flushBuffer();
  } else if (hiddenAt) {
    const gapMs = Date.now() - hiddenAt;
    hiddenAt = 0;
    if (gapMs > BG_NOTICE_MS) emit('recorder:background', { gapMs });
  }
});