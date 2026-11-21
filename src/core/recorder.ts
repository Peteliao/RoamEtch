// GPS recording engine: validation filters, gap segmentation, incremental persistence,
// incremental live stats. Storage is always WGS-84 regardless of region profile.
import { get } from './settings';
import { emit } from './events';
import { t } from './i18n';
import { haversine, uuid } from './geo';
import * as store from './store';
import { resolveAltitude } from './elevation';
import { acquireRecorderLock, releaseRecorderLock, broadcast, isHolding } from './locks';
import { requestWakeLock, releaseWakeLock } from './wakelock';
import { armKeepAlive, disarmKeepAlive } from './keepalive';
import { classifyActivity } from './activity';

const GAP_TIME = 5 * 60_000;   // > 5 min → new segment
const GAP_DIST = 500;          // > 500 m jump → new segment
const MOVING_SPEED = 0.5;      // m/s
const FLUSH_POINTS = 10;
const FLUSH_MS = 5000;
const SILENT_MS = 20_000;      // no fix callback at all → location likely switched off
const BG_NOTICE_MS = 15_000;   // background absence worth notifying about
const RESUME_BREAK_MS = 45_000;// long silence → start a fresh segment on return
const STALE_FIX_MS = 20_000;   // ignore cached fixes older than this
const JUMP_CONFIRM_MS = 60_000;// how long to wait for a relocated fix to confirm

const MAX_SPEED = { hike: 7, run: 12.5, bike: 22, drive: 70, travel: 70 }; // m/s

export const rec = {
  status: 'idle',              // idle | recording | paused | finished
  tripId: null,
  segmentId: null,
  simulated: false,
  permissionDenied: false,
  geoError: null,              // denied | unavailable | timeout | silent | null
  activityGuess: null,         // live classification while trip.activity === 'auto'
  tripActivity: 'auto',
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
let watchEpoch = 0;
let anchorT = 0;               // last valid fix time, including stationary ones
let pendingJump = null;        // candidate relocation awaiting a consistent next fix
let breakOnNextFix = false;    // background silence → split before accepting again
let forceAccLimit = 0;         // stricter gate for the first fix after a break
let lastWatchRestart = 0;
let fixChain = Promise.resolve();


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
  rec.tripActivity = trip.activity || 'auto';
  rec.status = 'recording';
  rec.startedAt = Date.now();
  rec.live = freshLive();
  rec.lastPoint = null;
  rec.firstFixT = 0; rec.lastFixT = 0;
  altSmooth = null; altRef = null;
  buffer = [];
  anchorT = 0; pendingJump = null; breakOnNextFix = false; forceAccLimit = 0;

  const seg = await store.addSegment(trip.id);
  rec.segmentId = seg.id;
  rec.live.segCount = await store.db.segments.where('tripId').equals(trip.id).count();
  await store.updateTrip(trip.id, { status: 'recording' });

  if (!simulated) startWatch();
  requestWakeLock();
  armKeepAlive();
  startTick();
  broadcast({ type: 'rec-state', state: 'recording', tripId: trip.id });
  emit('recorder:started', { tripId: trip.id, simulated });
  return true;
}

function onGeoError(err) {
  if (rec.status !== 'recording' || rec.simulated) return;
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
}

function onGeoPosition(pos) {
  if (rec.status !== 'recording' || rec.simulated) return;
  if (rec.geoError && rec.geoError !== 'denied') {
    rec.geoError = null;
    emit('recorder:geoerror', { code: null });
  }
  handleFix({
    lat: pos.coords.latitude, lon: pos.coords.longitude,
    acc: pos.coords.accuracy, alt: pos.coords.altitude, altAcc: pos.coords.altitudeAccuracy,
    speed: pos.coords.speed, heading: pos.coords.heading, t: pos.timestamp || Date.now()
  });
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
  const epoch = watchEpoch;
  watchId = navigator.geolocation.watchPosition(
    (pos) => { if (epoch === watchEpoch) onGeoPosition(pos); },
    (err) => { if (epoch === watchEpoch) onGeoError(err); },
    watchOptions()
  );
}

/** One immediate high-accuracy fix, mainly to wake iOS after a lock/suspension. */
function locateNow() {
  if (rec.simulated || rec.status !== 'recording' || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => onGeoPosition(pos),
    () => { /* watchPosition error path owns the UI state */ },
    { ...watchOptions(), maximumAge: 0 }
  );
}

/** Re-arm after a signal error or a suspended PWA. */
export function retryGeolocation() {
  if (rec.simulated || rec.status !== 'recording') return;
  rec.geoError = null;
  rec.lastFixWall = Date.now();
  armResumeBreak();
  startWatch();
  locateNow();
  emit('recorder:geoerror', { code: null });
}

function stopWatch() {
  watchEpoch++;
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}

function armResumeBreak() {
  if (rec.simulated || rec.status !== 'recording') return;
  if (!rec.lastFixT || Date.now() - rec.lastFixT > RESUME_BREAK_MS) {
    breakOnNextFix = true;
    forceAccLimit = Math.min(get('accuracyLimit'), 30);
  }
}

export function setRecordingActivity(activity) {
  if (rec.status === 'recording' || rec.status === 'paused') rec.tripActivity = activity;
}


/** Serialized fix pipeline — callbacks can overlap, but fixes must land in order. */
export function handleFix(fix) {
  const run = fixChain.then(() => processFix(fix));
  fixChain = run.catch((e) => console.error('fix failed', e));
  return run;
}

async function beginNewSegment(now, info, reasonKey) {
  await flushBuffer();
  const seg = await store.addSegment(rec.tripId, now);
  rec.segmentId = seg.id;
  rec.live.segCount++;
  rec.lastPoint = null;
  anchorT = 0;
  pendingJump = null;
  emit('recorder:gap', { ...info, reasonKey });
  emit('toast', { type: 'warn', msg: t(reasonKey) });
}

async function processFix(fix) {
  if (rec.status !== 'recording') return;
  const arrival = Date.now();
  const rawT = Number(fix?.t);
  const now = Number.isFinite(rawT) && rawT > 0 ? rawT : arrival;
  const lat = Number(fix?.lat), lon = Number(fix?.lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

  // Cached/queued fixes from before a suspension must never rewind the track.
  if ((rec.lastFixT && now <= rec.lastFixT) || arrival - now > STALE_FIX_MS) {
    return;
  }

  rec.lastFixWall = arrival;
  if (rec.geoError && rec.geoError !== 'denied') {
    rec.geoError = null;
    emit('recorder:geoerror', { code: null });
  }

  const accLimit = forceAccLimit || get('accuracyLimit');
  if (fix.acc != null && (!isFinite(fix.acc) || fix.acc > accLimit)) {
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'accuracy', count: rec.filteredCount });
    return;
  }
  if (!rec.firstFixT) rec.firstFixT = now;
  rec.lastFixT = now;

  const acc = fix.acc != null && isFinite(fix.acc) ? fix.acc : null;
  const fixSpeed = fix.speed != null && isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
  const tripActivity = rec.tripActivity || get('activity');
  // auto: stay permissive (travel envelope) until the classifier converges
  const activity = tripActivity === 'auto' ? (rec.activityGuess || 'travel') : tripActivity;
  const vmax = MAX_SPEED[activity] ?? 7;

  let dist = 0, dt = 0, implied = null;
  if (rec.lastPoint) {
    dist = haversine(rec.lastPoint.lat, rec.lastPoint.lon, lat, lon);
    const refT = anchorT || rec.lastPoint.t;
    dt = now - refT;
    if (dt > 0) implied = dist / (dt / 1000);
    // feed the auto-activity classifier even with fixes the filters reject
    if (dt > 0 && dt <= 60000) {
      const s = fixSpeed ?? implied;
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
  }

  const jumpFloor = Math.max(10, (acc ?? 15) * 1.2);
  const impossibleJump = !!rec.lastPoint && implied != null && implied > vmax * 1.4 && dist > jumpFloor;

  let relocated = false;
  // A long suspension starts a fresh segment instead of bridging the gap.
  if (breakOnNextFix && rec.lastPoint) {
    await beginNewSegment(now, { dist: Math.round(dist), dt: Math.round(dt), auto: true }, 'record.bgResumed');
    breakOnNextFix = false;
    forceAccLimit = 0;
    relocated = true;
    dist = 0; dt = 0; implied = null;
  } else if (breakOnNextFix) {
    breakOnNextFix = false;
    forceAccLimit = 0;
  }

  if (pendingJump && rec.lastPoint) {
    const candDt = (now - pendingJump.t) / 1000;
    const candDist = haversine(pendingJump.lat, pendingJump.lon, lat, lon);
    const consistent = now > pendingJump.t && now - pendingJump.t <= JUMP_CONFIRM_MS
      && candDist <= Math.max(70, vmax * candDt * 1.5 + 30);
    const nearOld = dist <= Math.max(50, ((acc ?? 15) + (rec.lastPoint.acc ?? 15)) * 2)
      && (implied == null || implied <= vmax * 1.4);
    if (consistent) {
      // Two mutually consistent fixes far from the old anchor: relocate honestly
      // in a new segment instead of dropping every subsequent point forever.
      await beginNewSegment(now, { dist: Math.round(candDist), dt: Math.round(candDt * 1000), auto: true }, 'record.geoRelocated');
      relocated = true;
      forceAccLimit = 0;
      dist = 0; dt = 0; implied = null;
    } else if (nearOld) {
      pendingJump = null;
    } else {
      pendingJump = { lat, lon, t: now, acc };
      rec.filteredCount++;
      emit('recorder:filtered', { reason: 'jump', count: rec.filteredCount });
      return;
    }
  }

  // ---- filter: unconfirmed teleport jump ----
  if (!relocated && impossibleJump) {
    pendingJump = { lat, lon, t: now, acc };
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'jump', count: rec.filteredCount });
    return;
  }

  if (rec.lastPoint) {
    // ---- accuracy-scaled deadband: stop resting fixes from drawing drifts ----
    const avgAcc = acc != null && rec.lastPoint.acc != null ? (acc + rec.lastPoint.acc) / 2 : (acc ?? rec.lastPoint.acc ?? 15);
    const deadband = Math.max(4, Math.min(20, avgAcc * 1.2));
    if (dist < deadband) {
      if (dt > 0 && dt <= 60000) {
        if (fixSpeed != null && fixSpeed > MOVING_SPEED) rec.live.movingMs += dt;
        else rec.live.stillMs += dt;
      }
      // Keep the gap clock alive: a long rest is not a GPS outage.
      anchorT = now;
      rec.live.speed = fixSpeed != null && fixSpeed > MOVING_SPEED ? fixSpeed : 0;
      rec.live.acc = acc;
      rec.live.lat = lat; rec.live.lon = lon;
      rec.live.heading = fix.heading != null && isFinite(fix.heading) ? fix.heading : null;
      emit('recorder:tick', { live: rec.live });
      return;
    }
    // ---- gap → new segment ----
    if (dt > GAP_TIME || dist > GAP_DIST) {
      await beginNewSegment(now, { dist: Math.round(dist), dt: Math.round(dt) }, 'record.gapNewSegment');
      dist = 0; dt = 0; implied = null;
    }
  }

  const speed = fixSpeed ?? (implied != null && dt <= 60000 ? implied : null);

  // GPS altitude is trusted immediately; network/cache lookup fills the point
  // asynchronously so a slow elevation service never stalls the fix queue.
  let alt = null, altSrc = null, altPromise = null;
  if (fix.alt != null && isFinite(fix.alt) && fix.altAcc != null && fix.altAcc <= 30) {
    alt = fix.alt; altSrc = 'gps';
  } else {
    altPromise = resolveAltitude(lat, lon, fix.alt, fix.altAcc);
  }

  const point: any = {
    lat, lon, t: now,
    alt, altSrc, acc,
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
  L.acc = acc;
  L.lat = lat; L.lon = lon;
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
  anchorT = now;
  pendingJump = null;
  forceAccLimit = 0;
  breakOnNextFix = false;
  buffer.push(point);
  if (altPromise) {
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
      // Some WebViews swallow the error callback when OS location is off, and
      // iOS can silently retire a watch after a lock. Re-arm periodically.
      if (!rec.simulated && !rec.permissionDenied && Date.now() - (rec.lastFixWall || rec.startedAt) > SILENT_MS) {
        if (!rec.geoError) {
          rec.geoError = 'silent';
          emit('recorder:geoerror', { code: 'silent' });
        }
        if (Date.now() - lastWatchRestart > 60_000) {
          lastWatchRestart = Date.now();
          startWatch();
          locateNow();
        }
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
  pendingJump = null; breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
  await store.updateTrip(rec.tripId, { status: 'paused' });
  releaseWakeLock();
  disarmKeepAlive();
  broadcast({ type: 'rec-state', state: 'paused', tripId: rec.tripId });
  emit('recorder:paused', { tripId: rec.tripId });
}

export async function resumeRecording() {
  if (rec.status !== 'paused' || !rec.tripId) return false;
  armKeepAlive();
  if (!rec.simulated && !isHolding() && !(await acquireRecorderLock())) {
    disarmKeepAlive();
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
  pendingJump = null; breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
  await store.updateTrip(rec.tripId, { status: 'recording' });
  if (!rec.simulated) startWatch();
  requestWakeLock();
  armKeepAlive();
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
  pendingJump = null; breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
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
  disarmKeepAlive();
  releaseRecorderLock();
  broadcast({ type: 'rec-state', state: 'finished', tripId: rec.tripId });
  emit('recorder:stopped', { tripId: rec.tripId });
  const id = rec.tripId;
  rec.tripId = null; rec.segmentId = null; rec.live = null; rec.lastPoint = null; rec.tripActivity = 'auto';
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
  rec.tripActivity = trip.activity || 'auto';
  speedSamples = [];
  rec.live = freshLive();
  // rebuild live counters from stored data
  const full = await store.loadTripFull(tripId);
  const { computeStats } = await import('./stats');
  const st = computeStats(full.segments, { ascentThreshold: get('ascentThreshold') });
  Object.assign(rec.live, {
    distance: st.distance, ascent: st.ascent, descent: st.descent,
    movingMs: st.movingMs, stillMs: st.stillMs, duration: st.duration,
    pointCount: st.pointCount, segCount: st.segCount, maxSpeed: st.maxSpeed
  });
  const lastSeg = full.segments[full.segments.length - 1];
  const lastPt = lastSeg?.points[lastSeg.points.length - 1];
  if (lastPt) { rec.lastPoint = lastPt; rec.lastFixT = lastPt.t || 0; altSmooth = lastPt.alt; altRef = lastPt.alt; }
  return resumeRecording();
}

/** Find trips left in recording/paused state (crash / kill recovery). */
export async function findRecoverableTrip() {
  const all = await store.listTrips();
  return all.find((tr) => tr.status === 'recording' || tr.status === 'paused') || null;
}

export async function createManualTrip(name = '') {
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
    const now = Date.now();
    const gapMs = now - hiddenAt;
    const silentMs = now - Math.max(hiddenAt, rec.lastFixT || 0);
    hiddenAt = 0;
    if (rec.status === 'recording' && !rec.simulated) {
      // iOS often retires the watch silently while locked; rebuild it and ask
      // for one fresh high-accuracy fix immediately.
      armResumeBreak();
      startWatch();
      locateNow();
    }
    if (gapMs > BG_NOTICE_MS) {
      emit('recorder:background', { gapMs, silentMs, autoBreak: breakOnNextFix });
    }
  }
});