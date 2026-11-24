// GPS recording engine: validation filters, gap segmentation, incremental persistence,
// incremental live stats. Storage is always WGS-84 regardless of region profile.
import { get } from './settings';
import { emit } from './events';
import { t } from './i18n';
import { haversine, physicsFor, uuid } from './geo';
import { createJumpGate, speedLimitFor } from './trackFilter';
import * as store from './store';
import { resolveAltitude } from './elevation';
import { acquireRecorderLock, releaseRecorderLock, broadcast, isHolding } from './locks';
import { requestWakeLock, releaseWakeLock } from './wakelock';
import { armKeepAlive, disarmKeepAlive } from './keepalive';
import { classifyActivity } from './activity';

const GAP_TIME = 5 * 60_000;   // > 5 min → new segment
const MOTION_HISTORY_MS = 120_000;
const MOVING_SPEED = 0.5;      // m/s
const FLUSH_POINTS = 10;
const FLUSH_MS = 5000;
const SILENT_MS = 20_000;      // no fix callback at all → location likely switched off
const BG_NOTICE_MS = 15_000;   // background absence worth notifying about
const RESUME_BREAK_MS = 45_000;// long silence → start a fresh segment on return
const STALE_FIX_MS = 5_000;    // ignore cached fixes older than this
const SAVE_RETRY_MS = 5000;
const SPILL_KEY = 'trackmint.pendingPoints.v1';

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
  startedAt: 0,
  saveState: { pending: 0, lastSavedAt: 0, error: null }
};

let watchId = null;
let buffer = [];
let inflight = null;
let flushTimer = null;
let saveRetryTimer = null;
let flushChain = Promise.resolve(true);
let tickTimer = null;
let altSmooth = null;
let altRef = null;
let pausedAt = 0;
let hiddenAt = 0;
let speedSamples = [];
let watchEpoch = 0;
let anchorT = 0;               // last valid fix time, including stationary ones
let motionHistory = [];
const jumpGate = createJumpGate();
let breakOnNextFix = false;    // background silence → split before accepting again
let forceAccLimit = 0;         // stricter gate for the first fix after a break
let lastWatchRestart = 0;
let fixChain = Promise.resolve();
let suspendFixIngest = false;
let stopPromise = null;


function freshLive() {
  return {
    distance: 0, ascent: 0, descent: 0, activeMs: 0, movingMs: 0, stillMs: 0, duration: 0,
    speed: null, alt: null, altSrc: null, slope: null, acc: null,
    lat: null, lon: null, heading: null, pointCount: 0, segCount: 0, maxSpeed: 0
  };
}

function emitPersistence() {
  rec.saveState.pending = buffer.length + (inflight?.length || 0);
  emit('recorder:persistence', { ...rec.saveState });
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
  return null;
}

function resetSaveState() {
  rec.saveState = { pending: 0, lastSavedAt: 0, error: null };
  emitPersistence();
}

function watchOptions() {
  const q = get('recordQuality');
  if (q === 'high') return { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 };
  if (q === 'low') return { enableHighAccuracy: false, maximumAge: 0, timeout: 30000 };
  return { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };
}

export async function startRecording({ tripId = null, name = '', activity = null, simulated = false } = {}) {
  if (rec.status === 'recording') return true;
  if (rec.status === 'paused') return false;
  let lockHeld = false;
  let createdTripId = null;
  let started = false;
  try {
    if (!simulated) {
      if (!navigator.geolocation) {
        rec.permissionDenied = true;
        rec.geoError = 'denied';
        emit('recorder:geoerror', { code: 'denied' });
        emit('recorder:denied');
        return false;
      }
      if (!(await acquireRecorderLock())) {
        emit('recorder:busy');
        return false;
      }
      lockHeld = true;
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
      createdTripId = trip.id;
    }
    rec.tripId = trip.id;
    rec.tripActivity = trip.activity || 'auto';
    rec.startedAt = Date.now();
    rec.live = freshLive();
    rec.lastPoint = null;
    rec.firstFixT = 0; rec.lastFixT = 0;
    altSmooth = null; altRef = null;
    buffer = [];
    inflight = null;
    anchorT = 0; resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0;
    suspendFixIngest = false;
    resetSaveState();

    const seg = await store.addSegment(trip.id);
    rec.segmentId = seg.id;
    rec.live.segCount = await store.db.segments.where('tripId').equals(trip.id).count();
    await store.updateTrip(trip.id, { status: 'recording' });

    if (!simulated && !startWatch()) throw new Error('geolocation unavailable');
    requestWakeLock();
    armKeepAlive();
    startTick();
    rec.status = 'recording';
    broadcast({ type: 'rec-state', state: 'recording', tripId: trip.id });
    emit('recorder:started', { tripId: trip.id, simulated });
    started = true;
    return true;
  } catch (e) {
    console.error('start recording failed', e);
    emit('recorder:starterror', { error: String(e) });
    throw e;
  } finally {
    if (!started) {
      stopWatch();
      stopTick();
      releaseWakeLock();
      disarmKeepAlive();
      buffer = [];
      inflight = null;
      suspendFixIngest = false;
      rec.status = 'idle';
      rec.tripId = null;
      rec.segmentId = null;
      rec.live = null;
      rec.lastPoint = null;
      rec.tripActivity = 'auto';
      rec.simulated = false;
      rec.saveState = { pending: 0, lastSavedAt: 0, error: null };
      if (lockHeld) releaseRecorderLock();
      if (createdTripId) await store.deleteTrip(createdTripId).catch(() => {});
    }
  }
}

function onGeoError(err) {
  if (rec.status !== 'recording' || rec.simulated) return;
  if (err.code === 1) {
    rec.permissionDenied = true;
    rec.geoError = 'denied';
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    void pauseRecording();
  } else {
    // code 2 = OS location off / no source; code 3 = timeout (weak signal)
    rec.geoError = err.code === 2 ? 'unavailable' : 'timeout';
    emit('recorder:geoerror', { code: rec.geoError });
    if (err.code === 2) void pauseRecording();
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
    return false;
  }
  stopWatch();
  const epoch = watchEpoch;
  try {
    watchId = navigator.geolocation.watchPosition(
      (pos) => { if (epoch === watchEpoch) onGeoPosition(pos); },
      (err) => { if (epoch === watchEpoch) onGeoError(err); },
      watchOptions()
    );
    return true;
  } catch (e) {
    console.error('watchPosition failed', e);
    rec.geoError = 'unavailable';
    emit('recorder:geoerror', { code: 'unavailable' });
    return false;
  }
}

/** One immediate high-accuracy fix, mainly to wake iOS after a lock/suspension. */
function locateNow() {
  if (rec.simulated || rec.status !== 'recording' || !navigator.geolocation) return;
  const epoch = watchEpoch;
  navigator.geolocation.getCurrentPosition(
    (pos) => { if (epoch === watchEpoch) onGeoPosition(pos); },
    () => { /* watchPosition error path owns the UI state */ },
    { ...watchOptions(), maximumAge: 0 }
  );
}

/** Re-arm after a signal error or a suspended PWA. */
export function retryGeolocation() {
  if (rec.simulated || rec.status !== 'recording') return;
  if (!navigator.geolocation) {
    rec.permissionDenied = true;
    rec.geoError = 'denied';
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    void pauseRecording();
    return;
  }
  rec.geoError = null;
  rec.lastFixWall = Date.now();
  armResumeBreak();
  if (!startWatch()) {
    void pauseRecording();
    return;
  }
  locateNow();
  emit('recorder:geoerror', { code: null });
}

function stopWatch() {
  watchEpoch++;
  if (watchId != null) {
    try { navigator.geolocation?.clearWatch(watchId); } catch { /* already gone */ }
    watchId = null;
  }
}

function armResumeBreak() {
  if (rec.simulated || rec.status !== 'recording') return;
  if (!rec.lastFixT || Date.now() - rec.lastFixT > RESUME_BREAK_MS) {
    breakOnNextFix = true;
    forceAccLimit = Math.min(get('accuracyLimit'), 30);
  }
}

export function setRecordingActivity(activity) {
  if (rec.status === 'recording' || rec.status === 'paused') {
    rec.tripActivity = activity;
    resetMotionFilter();
  }
}


/** Serialized fix pipeline — callbacks can overlap, but fixes must land in order. */
export function handleFix(fix) {
  const run = fixChain.then(() => processFix(fix));
  fixChain = run.catch((e) => console.error('fix failed', e));
  return run;
}

async function beginNewSegment(now, info, reasonKey) {
  if (!(await flushBuffer())) return false;
  const seg = await store.addSegment(rec.tripId, now);
  rec.segmentId = seg.id;
  rec.live.segCount++;
  rec.lastPoint = null;
  anchorT = 0;
  resetMotionFilter();
  emit('recorder:gap', { ...info, reasonKey });
  emit('toast', { type: 'warn', msg: t(reasonKey) });
  return true;
}

function resetMotionFilter() {
  motionHistory = [];
  jumpGate.reset();
}

function rememberMotion(point) {
  const cutoff = point.t - MOTION_HISTORY_MS;
  motionHistory = motionHistory.filter((p) => p.t >= cutoff);
  motionHistory.push(point);
  if (motionHistory.length > 400) motionHistory.splice(0, motionHistory.length - 400);
}

function feedAutoActivity(speed, dt, tripActivity) {
  if (tripActivity !== 'auto' || speed == null || speed <= MOVING_SPEED) return;
  if (dt !== 0 && !(dt > 0 && dt <= 60_000)) return;
  speedSamples.push(speed);
  if (speedSamples.length > 400) speedSamples.shift();
  if (speedSamples.length >= 6 && (!rec.activityGuess || speedSamples.length % 5 === 0)) {
    const guess = classifyActivity(speedSamples);
    if (guess && guess !== rec.activityGuess) {
      rec.activityGuess = guess;
      emit('activity:guess', { activity: guess });
    }
  }
}

function acceptPoint(fix, now, acc, fixSpeed, activity, dist = 0, dt = 0, implied = null) {
  const lat = Number(fix.lat), lon = Number(fix.lon);
  const absoluteLimit = physicsFor('travel').vmax * 1.3;
  const reported = fixSpeed != null && fixSpeed <= absoluteLimit ? fixSpeed : null;
  const speed = implied != null && dt > 0 && dt <= 60_000 ? implied : reported;

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

  const L = rec.live;
  L.distance += dist;
  if (dt > 0 && dt <= 60_000) {
    L.activeMs += dt;
    if (speed != null && speed > MOVING_SPEED) L.movingMs += dt;
    else L.stillMs += dt;
  }
  L.speed = speed;
  L.acc = acc;
  L.lat = lat; L.lon = lon;
  L.heading = fix.heading != null && isFinite(fix.heading) ? fix.heading : null;
  L.pointCount++;
  if (speed != null && speed > L.maxSpeed && speed <= speedLimitFor(activity, fix)) L.maxSpeed = speed;
  if (alt != null) {
    altSmooth = altSmooth == null ? alt : 0.35 * alt + 0.65 * altSmooth;
    if (altRef == null) altRef = altSmooth;
    const d = altSmooth - altRef;
    const th = get('ascentThreshold');
    if (d >= th) { L.ascent += d; altRef = altSmooth; }
    else if (d <= -th) { L.descent += -d; altRef = altSmooth; }
    L.alt = alt; L.altSrc = altSrc;
  }
  const recent = [...buffer.slice(-6), point];
  if (recent.length > 1 && alt != null) {
    let j = recent.length - 2, dd = 0;
    while (j > 0 && dd < 30) { dd += haversine(recent[j].lat, recent[j].lon, recent[j + 1].lat, recent[j + 1].lon); j--; }
    const q = recent[j];
    if (q.alt != null && dd >= 5) L.slope = ((alt - q.alt) / dd) * 100;
  }

  rec.lastPoint = point;
  anchorT = now;
  forceAccLimit = 0;
  breakOnNextFix = false;
  rememberMotion(point);
  buffer.push(point);
  feedAutoActivity(speed, dt, rec.tripActivity);
  emitPersistence();
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
  if (buffer.length >= FLUSH_POINTS) void flushBuffer();
  else if (!flushTimer) flushTimer = setTimeout(flushBuffer, FLUSH_MS);
  emit('recorder:point', { point, live: L });
}

async function processFix(fix) {
  if (rec.status !== 'recording' || suspendFixIngest) return;
  const arrival = Date.now();
  const rawT = Number(fix?.t);
  const now = Number.isFinite(rawT) && rawT > 0 ? rawT : arrival;
  const lat = Number(fix?.lat), lon = Number(fix?.lon);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;

  // Cached/queued fixes from before a suspension must never rewind the track.
  if ((rec.lastFixT && now <= rec.lastFixT) || arrival - now > STALE_FIX_MS) return;

  rec.lastFixWall = arrival;
  if (rec.geoError && rec.geoError !== 'denied') {
    rec.geoError = null;
    emit('recorder:geoerror', { code: null });
  }

  const accLimit = forceAccLimit || get('accuracyLimit');
  if (fix.acc != null && (!isFinite(fix.acc) || fix.acc <= 0 || fix.acc > accLimit)) {
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'accuracy', count: rec.filteredCount });
    return;
  }
  if (!rec.firstFixT) rec.firstFixT = now;
  rec.lastFixT = now;

  const acc = fix.acc != null && isFinite(fix.acc) ? fix.acc : null;
  const fixSpeed = fix.speed != null && isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null;
  const tripActivity = rec.tripActivity || get('activity');
  const activity = tripActivity === 'auto' ? (rec.activityGuess || 'auto') : tripActivity;

  let dist = 0, dt = 0, implied = null;
  if (rec.lastPoint) {
    dist = haversine(rec.lastPoint.lat, rec.lastPoint.lon, lat, lon);
    const refT = anchorT || rec.lastPoint.t;
    dt = now - refT;
    if (dt > 0) implied = dist / (dt / 1000);
  }

  if (breakOnNextFix && rec.lastPoint) {
    if (!(await beginNewSegment(now, { dist: Math.round(dist), dt: Math.round(dt), auto: true }, 'record.bgResumed'))) return;
    dist = 0; dt = 0; implied = null;
  } else if (breakOnNextFix) {
    breakOnNextFix = false;
    forceAccLimit = 0;
  }

  const decision = jumpGate.evaluate({ fix, anchor: rec.lastPoint, history: motionHistory, activity });
  if (decision.action === 'pending') {
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'jump', count: rec.filteredCount });
    return;
  }
  if (decision.action === 'confirm') {
    const first = decision.points[0];
    const jumpDist = haversine(rec.lastPoint.lat, rec.lastPoint.lon, first.lat, first.lon);
    const jumpDt = first.t - (anchorT || rec.lastPoint.t);
    if (!(await beginNewSegment(first.t, { dist: Math.round(jumpDist), dt: Math.round(jumpDt), auto: true }, 'record.geoRelocated'))) return;
    rec.filteredCount = Math.max(0, rec.filteredCount - (decision.points.length - 1));
    let previous = null;
    for (const candidate of decision.points) {
      let cDist = 0, cDt = 0, cImplied = null;
      if (previous) {
        cDist = haversine(previous.lat, previous.lon, candidate.lat, candidate.lon);
        cDt = candidate.t - previous.t;
        if (cDt > 0) cImplied = cDist / (cDt / 1000);
      }
      const candidateActivity = rec.tripActivity === 'auto' ? (rec.activityGuess || 'auto') : rec.tripActivity;
      acceptPoint(candidate, candidate.t, candidate.acc ?? null, candidate.speed ?? null, candidateActivity, cDist, cDt, cImplied);
      previous = rec.lastPoint;
    }
    return;
  }

  if (rec.lastPoint) {
    const avgAcc = acc != null && rec.lastPoint.acc != null ? (acc + rec.lastPoint.acc) / 2 : (acc ?? rec.lastPoint.acc ?? 15);
    const deadband = Math.max(4, Math.min(20, avgAcc * 1.2));
    if (dist < deadband) {
      if (dt > 0 && dt <= 60_000) {
        rec.live.activeMs += dt;
        if (fixSpeed != null && fixSpeed > MOVING_SPEED && fixSpeed <= physicsFor('travel').vmax * 1.3) rec.live.movingMs += dt;
        else rec.live.stillMs += dt;
      }
      anchorT = now;
      rec.live.speed = fixSpeed != null && fixSpeed > MOVING_SPEED && fixSpeed <= physicsFor('travel').vmax * 1.3 ? fixSpeed : 0;
      rec.live.acc = acc;
      rec.live.lat = lat; rec.live.lon = lon;
      rec.live.heading = fix.heading != null && isFinite(fix.heading) ? fix.heading : null;
      emit('recorder:tick', { live: rec.live });
      return;
    }
    if (dt > GAP_TIME) {
      if (!(await beginNewSegment(now, { dist: Math.round(dist), dt: Math.round(dt) }, 'record.gapNewSegment'))) return;
      dist = 0; dt = 0; implied = null;
    }
  }

  acceptPoint(fix, now, acc, fixSpeed, activity, dist, dt, implied);
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

export function flushBuffer() {
  flushTimer = clearTimer(flushTimer);
  const run = flushChain.then(doFlush, doFlush).catch((e) => {
    console.error('flush crashed', e);
    return false;
  });
  flushChain = run;
  return run;
}

async function doFlush() {
  if (!buffer.length || !rec.segmentId || !rec.tripId) return true;
  if (saveRetryTimer) { saveRetryTimer = clearTimer(saveRetryTimer); }
  const pts = buffer;
  buffer = [];
  inflight = pts;
  const segId = rec.segmentId;
  pts.forEach((p) => { p._flushed = true; p._segmentId = segId; });
  emitPersistence();
  try {
    await store.appendPoints(segId, rec.tripId, pts.map(stripInternal));
    inflight = null;
    rec.saveState.error = null;
    rec.saveState.lastSavedAt = Date.now();
    clearSpill(segId);
    emit('recorder:saved', { count: pts.length });
    emitPersistence();
    return true;
  } catch (e) {
    console.error('flush failed', e);
    inflight = null;
    buffer.unshift(...pts);
    rec.saveState.error = 'write';
    emit('recorder:saveerror', { error: 'write', pending: buffer.length });
    emitPersistence();
    scheduleSaveRetry();
    return false;
  }
}

function scheduleSaveRetry() {
  if (saveRetryTimer || !buffer.length) return;
  saveRetryTimer = setTimeout(() => {
    saveRetryTimer = null;
    if (buffer.length && rec.segmentId) void flushBuffer();
  }, SAVE_RETRY_MS);
}

function spillPending() {
  const pending = inflight ? [...inflight, ...buffer] : buffer;
  if (!pending.length || !rec.tripId || !rec.segmentId) return;
  try {
    localStorage.setItem(SPILL_KEY, JSON.stringify({
      tripId: rec.tripId,
      segmentId: rec.segmentId,
      savedAt: Date.now(),
      points: pending.map(stripInternal)
    }));
  } catch { /* quota or privacy mode — nothing more we can do synchronously */ }
}

function clearSpill(segmentId) {
  try {
    const raw = localStorage.getItem(SPILL_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.segmentId || data.segmentId === segmentId) localStorage.removeItem(SPILL_KEY);
  } catch {
    try { localStorage.removeItem(SPILL_KEY); } catch { /* ignore */ }
  }
}

/** Recover fixes spilled synchronously when the page was closed mid-flush. */
export async function recoverPendingSpill() {
  let raw = null;
  try { raw = localStorage.getItem(SPILL_KEY); } catch { return 0; }
  if (!raw) return 0;
  let data;
  try { data = JSON.parse(raw); } catch {
    try { localStorage.removeItem(SPILL_KEY); } catch { /* ignore */ }
    return 0;
  }
  if (!data?.tripId || !data?.segmentId || !Array.isArray(data.points)) {
    try { localStorage.removeItem(SPILL_KEY); } catch { /* ignore */ }
    return 0;
  }
  try {
    const trip = await store.getTrip(data.tripId);
    if (!trip || (trip.status !== 'recording' && trip.status !== 'paused')) {
      localStorage.removeItem(SPILL_KEY);
      return 0;
    }
    const seg = await store.db.segments.get(data.segmentId);
    if (!seg || seg.tripId !== data.tripId) {
      localStorage.removeItem(SPILL_KEY);
      return 0;
    }
    const chunks = await store.db.trackChunks.where('segmentId').equals(data.segmentId).toArray();
    let lastT = -Infinity;
    for (const c of chunks) {
      for (const p of c.points || []) {
        if (Number.isFinite(p.t) && p.t > lastT) lastT = p.t;
      }
    }
    const seen = new Set();
    const fresh = [];
    for (const p of data.points) {
      if (!p || !Number.isFinite(p.t) || p.t <= lastT || seen.has(p.t)) continue;
      if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)
        || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) continue;
      seen.add(p.t);
      fresh.push(stripInternal(p));
    }
    fresh.sort((a, b) => a.t - b.t);
    if (!fresh.length) {
      localStorage.removeItem(SPILL_KEY);
      return 0;
    }
    await store.appendPoints(data.segmentId, data.tripId, fresh);
    localStorage.removeItem(SPILL_KEY);
    emit('recorder:spillrecovered', { count: fresh.length });
    return fresh.length;
  } catch (e) {
    console.warn('pending spill recovery failed', e);
    return 0;
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
  if (rec.status !== 'recording') return false;
  suspendFixIngest = true;
  if (!rec.simulated) stopWatch();
  await fixChain.catch(() => {});
  if (!(await flushBuffer())) {
    suspendFixIngest = false;
    rec.lastFixWall = Date.now();
    if (!rec.simulated) {
      armResumeBreak();
      startWatch();
      locateNow();
    }
    return false;
  }
  rec.status = 'paused';
  suspendFixIngest = false;
  pausedAt = Date.now();
  resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
  await store.updateTrip(rec.tripId, { status: 'paused' }).catch((e) => console.error('trip status update failed', e));
  rec.saveState.pending = 0;
  emitPersistence();
  releaseWakeLock();
  disarmKeepAlive();
  broadcast({ type: 'rec-state', state: 'paused', tripId: rec.tripId });
  emit('recorder:paused', { tripId: rec.tripId });
  return true;
}

export async function resumeRecording() {
  if (rec.status !== 'paused' || !rec.tripId) return false;
  if (!rec.simulated && !navigator.geolocation) {
    rec.permissionDenied = true;
    rec.geoError = 'denied';
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    return false;
  }
  armKeepAlive();
  let acquired = false;
  if (!rec.simulated && !isHolding()) {
    if (!(await acquireRecorderLock())) {
      disarmKeepAlive();
      emit('recorder:busy');
      return false;
    }
    acquired = true;
  }
  // pause/resume always starts a fresh segment (no straight-line bridging)
  if (!(await flushBuffer())) {
    if (acquired) releaseRecorderLock();
    disarmKeepAlive();
    return false;
  }
  const prevSegmentId = rec.segmentId;
  const prevSegCount = rec.live?.segCount || 0;
  const prevLastPoint = rec.lastPoint;
  try {
    const seg = await store.addSegment(rec.tripId);
    rec.segmentId = seg.id;
    rec.lastPoint = null;
    rec.live.segCount++;
    rec.status = 'recording';
    rec.startedAt = Date.now() - (rec.live?.duration || 0);
    rec.permissionDenied = false;
    rec.geoError = null;
    rec.lastFixWall = Date.now();
    resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
    suspendFixIngest = false;
    await store.updateTrip(rec.tripId, { status: 'recording' }).catch((e) => console.error('trip status update failed', e));
    if (!rec.simulated && !startWatch()) {
      rec.status = 'paused';
      suspendFixIngest = false;
      rec.segmentId = prevSegmentId;
      rec.lastPoint = prevLastPoint;
      if (rec.live) rec.live.segCount = prevSegCount;
      await store.deleteSegment(seg.id).catch(() => {});
      await store.updateTrip(rec.tripId, { status: 'paused' }).catch(() => {});
      if (acquired) releaseRecorderLock();
      disarmKeepAlive();
      emit('recorder:paused', { tripId: rec.tripId });
      return false;
    }
    requestWakeLock();
    armKeepAlive();
    startTick();
    broadcast({ type: 'rec-state', state: 'recording', tripId: rec.tripId });
    emit('recorder:resumed', { tripId: rec.tripId });
    return true;
  } catch (e) {
    if (acquired) releaseRecorderLock();
    disarmKeepAlive();
    throw e;
  }
}

export function stopRecording() {
  if (!stopPromise) stopPromise = doStopRecording().finally(() => { stopPromise = null; });
  return stopPromise;
}

async function doStopRecording() {
  if (rec.status === 'idle' || rec.status === 'finished') return null;
  suspendFixIngest = true;
  stopWatch();
  stopTick();
  await fixChain.catch(() => {});
  if (!(await flushBuffer())) {
    suspendFixIngest = false;
    rec.lastFixWall = Date.now();
    startTick();
    if (!rec.simulated) {
      armResumeBreak();
      startWatch();
      locateNow();
    }
    return null;
  }
  try {
    // pause/resume without fixes leaves empty segments — prune them at stop
    const full = await store.loadTripFull(rec.tripId);
    for (const s of full.segments) if (!s.points.length) await store.deleteSegment(s.id);
    if (rec.tripId) {
      const tr = await store.getTrip(rec.tripId);
      const finalActivity = tr?.activity === 'auto'
        ? (rec.activityGuess || classifyActivity(speedSamples) || 'hike')
        : null;
      await store.updateTrip(rec.tripId, finalActivity ? { status: 'finished', activity: finalActivity } : { status: 'finished' });
    }
    rec.status = 'finished';
    releaseWakeLock();
    disarmKeepAlive();
    releaseRecorderLock();
    broadcast({ type: 'rec-state', state: 'finished', tripId: rec.tripId });
    emit('recorder:stopped', { tripId: rec.tripId });
    rec.saveState.pending = 0;
    rec.saveState.error = null;
    emitPersistence();
    const id = rec.tripId;
    rec.tripId = null; rec.segmentId = null; rec.live = null; rec.lastPoint = null; rec.tripActivity = 'auto';
    return id;
  } catch (e) {
    console.error('stop failed', e);
    rec.status = 'paused';
    rec.saveState.error = 'finalize';
    emit('recorder:saveerror', { error: 'finalize', pending: 0 });
    emitPersistence();
    return null;
  } finally {
    suspendFixIngest = false;
  }
}

/** Continue an interrupted trip found at boot (new segment, no data loss). */
export async function continueTrip(tripId) {
  const trip = await store.getTrip(tripId);
  if (!trip) return false;
  if (!(await acquireRecorderLock())) { emit('recorder:busy'); return false; }
  try {
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
    const st = computeStats(full.segments, {
      ascentThreshold: get('ascentThreshold'),
      activity: rec.tripActivity,
      weightKg: get('weightKg')
    });
    Object.assign(rec.live, {
      distance: st.distance, ascent: st.ascent, descent: st.descent,
      activeMs: st.activeMs, movingMs: st.movingMs, stillMs: st.stillMs, duration: st.duration,
      pointCount: st.pointCount, segCount: st.segCount, maxSpeed: st.maxSpeed
    });
    const lastSeg = full.segments[full.segments.length - 1];
    const lastPt = lastSeg?.points[lastSeg.points.length - 1];
    if (lastPt) { rec.lastPoint = lastPt; rec.lastFixT = lastPt.t || 0; altSmooth = lastPt.alt; altRef = lastPt.alt; }
    const ok = await resumeRecording();
    if (!ok) releaseRecorderLock();
    return ok;
  } catch (e) {
    releaseRecorderLock();
    throw e;
  }
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
window.addEventListener('pagehide', () => { spillPending(); void flushBuffer(); });

// Backgrounding: flush immediately; on return, tell the UI about the absence so it
// can explain possible OS-level pauses (iOS suspends the page, Android throttles it).
document.addEventListener('visibilitychange', () => {
  if (rec.status !== 'recording' && rec.status !== 'paused') return;
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    spillPending();
    void flushBuffer();
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