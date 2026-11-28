// GPS recording engine: validation filters, gap segmentation, incremental persistence,
// incremental live stats. Storage is always WGS-84 regardless of region profile.
import { get } from './settings';
import { emit } from './events';
import { currentLang, t } from './i18n';
import { languageTag } from './language';
import { haversine, physicsFor, uuid } from './geo';
import { createJumpGate, speedLimitFor } from './trackFilter';
import * as store from './store';
import { patchFlushedAltitude, resolveAltitude } from './elevation';
import { acquireRecorderLock, releaseRecorderLock, broadcast, isHolding } from './locks';
import { requestWakeLock, releaseWakeLock } from './wakelock';
import { armKeepAlive, disarmKeepAlive } from './keepalive';
import {
  ACTIVITY_CONFIDENCE_THRESHOLD, classifyActivityDetailed,
  type ActivityClassification, type ActivitySample
} from './activity';
import {
  assessRecordingQuality, type AccuracySample, type BatteryReading,
  type RecordingQuality, type StorageReading
} from './gpsQuality';
import { migrateLegacyKey } from './storageKeys';
import { computeStatsSummaryAsync } from './workerBridge';

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
export const MAX_PENDING_POINTS = 5000;
const SPILL_KEY = 'roametch.pendingPoints.v1';
migrateLegacyKey('trackmint.pendingPoints.v1', SPILL_KEY);

export const rec = {
  status: 'idle',              // idle | recording | paused | finished
  tripId: null,
  segmentId: null,
  simulated: false,
  permissionDenied: false,
  geoError: null,              // denied | unavailable | timeout | silent | null
  activityGuess: null,         // applied live classification while trip.activity === 'auto'
  activityClassification: null as ActivityClassification | null,
  tripActivity: 'auto',
  filteredCount: 0,
  live: null,
  quality: null as RecordingQuality | null,
  lastPoint: null,
  lastFixT: 0,
  lastValidFixT: 0,            // accepted, in-limit fix (stationary fixes included)
  lastFixWall: 0,
  firstFixT: 0,
  startedAt: 0,
  saveState: { pending: 0, lastSavedAt: 0, error: null, degraded: false }
};

let watchId = null;
let buffer = [];
let inflight = null;
let flushTimer = null;
let saveRetryTimer = null;
let flushChain = Promise.resolve(true);
let flushRunning = false;
let flushAgain = false;
let tickTimer = null;
let geoRetryTimer = null;
let geoRetryAttempts = 0;
let altSmooth = null;
let altRef = null;
let pausedAt = 0;
let hiddenAt = 0;
let activitySamples: ActivitySample[] = [];
let watchEpoch = 0;             // watch callback generation
let qualityEpoch = 0;           // device-status callback generation
let qualityTimer = null;
let batteryMonitor: any = null;
let batteryOnLevel = null;
let batteryOnCharging = null;
let deviceCheckInFlight = false;
let qualityObservedFixes = 0;
let qualityValidFixes = 0;
let qualityInvalidFixes = 0;
let qualityFirstFixT = 0;
let qualityLastFixT = 0;
let qualityFirstPointT = 0;
let qualityLastPointT = 0;
let qualitySegmentStartedAt = 0;
let qualityActiveElapsedMs = 0;
let qualityActiveStartedAt = 0;
let qualityPausedSpans: { start: number; end: number | null }[] = [];
let accuracySamples: AccuracySample[] = [];
let storageReading: StorageReading = { supported: false, usage: null, quota: null, usageRatio: null, checkedAt: null };
let batteryReading: BatteryReading = { supported: false, level: null, charging: null, checkedAt: null };
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

function resetActivityAndQuality() {
  activitySamples = [];
  rec.activityGuess = null;
  rec.activityClassification = null;
  rec.lastValidFixT = 0;
  qualityObservedFixes = 0;
  qualityValidFixes = 0;
  qualityInvalidFixes = 0;
  qualityFirstFixT = 0;
  qualityLastFixT = 0;
  qualityFirstPointT = 0;
  qualityLastPointT = 0;
  accuracySamples = [];
  qualitySegmentStartedAt = Date.now();
  qualityActiveElapsedMs = 0;
  qualityActiveStartedAt = 0;
  qualityPausedSpans = [];
  const hasStorage = typeof navigator !== 'undefined' && typeof navigator.storage?.estimate === 'function';
  const hasBattery = typeof navigator !== 'undefined' && typeof (navigator as any).getBattery === 'function';
  storageReading = { supported: hasStorage, usage: null, quota: null, usageRatio: null, checkedAt: null };
  batteryReading = { supported: hasBattery, level: null, charging: null, checkedAt: null };
  rec.quality = null;
}

function activeDurationMs(now = Date.now()) {
  if (!qualityActiveStartedAt && !qualityActiveElapsedMs) return null;
  return qualityActiveElapsedMs + (qualityActiveStartedAt ? Math.max(0, now - qualityActiveStartedAt) : 0);
}

function refreshQuality(notify = true) {
  if (!rec.live || !rec.tripId || (rec.status !== 'recording' && rec.status !== 'paused')) return;
  const now = Date.now();
  rec.quality = assessRecordingQuality({
    now,
    durationMs: activeDurationMs(now),
    segmentStartedAt: qualitySegmentStartedAt || rec.startedAt || now,
    pausedSpans: qualityPausedSpans,
    firstValidFixT: qualityFirstFixT || null,
    lastValidFixT: qualityLastFixT || null,
    firstPointT: qualityFirstPointT || null,
    lastPointT: qualityLastPointT || null,
    observedFixes: qualityObservedFixes,
    validFixes: qualityValidFixes,
    invalidFixes: qualityInvalidFixes,
    accuracySamples,
    storage: storageReading,
    battery: batteryReading,
    saveState: rec.saveState
  });
  if (notify) emit('recorder:quality', { quality: rec.quality, tripId: rec.tripId, epoch: qualityEpoch });
}

function qualityMonitorCurrent(epoch, tripId) {
  return epoch === qualityEpoch && rec.tripId === tripId
    && (rec.status === 'recording' || rec.status === 'paused');
}

function readBattery(epoch: number, tripId: string, battery: any) {
  if (!qualityMonitorCurrent(epoch, tripId) || !battery) return;
  const rawLevel = battery.level;
  const level = typeof rawLevel === 'number' ? rawLevel : null;
  batteryReading = {
    supported: true,
    level: level != null && Number.isFinite(level) && level >= 0 && level <= 1 ? level : null,
    charging: typeof battery.charging === 'boolean' ? battery.charging : null,
    checkedAt: Date.now()
  };
  refreshQuality();
}

async function checkStorage(epoch: number, tripId: string) {
  if (!qualityMonitorCurrent(epoch, tripId) || deviceCheckInFlight) return;
  if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
    storageReading = { ...storageReading, supported: false };
    refreshQuality();
    return;
  }
  deviceCheckInFlight = true;
  try {
    const estimate = await navigator.storage.estimate();
    if (!qualityMonitorCurrent(epoch, tripId)) return;
    storageReading = {
      supported: true,
      usage: Number.isFinite(estimate?.usage) && estimate.usage >= 0 ? estimate.usage : null,
      quota: Number.isFinite(estimate?.quota) && estimate.quota > 0 ? estimate.quota : null,
      usageRatio: null,
      checkedAt: Date.now()
    };
    refreshQuality();
  } catch {
    // Keep the last successful estimate (if any); an unavailable quota is not zero.
  } finally {
    if (epoch === qualityEpoch) deviceCheckInFlight = false;
  }
}

function startQualityMonitoring() {
  stopQualityMonitoring();
  if (!qualityActiveStartedAt) qualityActiveStartedAt = Date.now();
  const epoch = qualityEpoch;
  const tripId = rec.tripId;
  if (!tripId) return;
  qualityTimer = setInterval(() => {
    if (!qualityMonitorCurrent(epoch, tripId)) return;
    refreshQuality(false);
    void checkStorage(epoch, tripId);
  }, 15_000);
  const getBattery = typeof navigator !== 'undefined' ? (navigator as any).getBattery : null;
  if (typeof getBattery === 'function') {
    batteryReading = { supported: true, level: null, charging: null, checkedAt: null };
    Promise.resolve().then(() => getBattery.call(navigator)).then((battery) => {
      if (!qualityMonitorCurrent(epoch, tripId)) return;
      batteryMonitor = battery;
      batteryOnLevel = () => readBattery(epoch, tripId, battery);
      batteryOnCharging = () => readBattery(epoch, tripId, battery);
      battery?.addEventListener?.('levelchange', batteryOnLevel);
      battery?.addEventListener?.('chargingchange', batteryOnCharging);
      readBattery(epoch, tripId, battery);
    }).catch(() => { /* Battery Status is optional and absent on many browsers. */ });
  }
  void checkStorage(epoch, tripId);
  refreshQuality();
}

function stopQualityMonitoring() {
  qualityEpoch++;
  if (qualityTimer) clearInterval(qualityTimer);
  qualityTimer = null;
  if (batteryMonitor && batteryOnLevel) batteryMonitor.removeEventListener?.('levelchange', batteryOnLevel);
  if (batteryMonitor && batteryOnCharging) batteryMonitor.removeEventListener?.('chargingchange', batteryOnCharging);
  batteryMonitor = null;
  batteryOnLevel = null;
  batteryOnCharging = null;
  deviceCheckInFlight = false;
}

function pendingPointCount() {
  return buffer.length + (inflight?.length || 0);
}

function enterSaveDegraded() {
  const entered = !rec.saveState.degraded;
  rec.saveState.error = 'capacity';
  rec.saveState.degraded = true;
  if (entered) {
    emit('recorder:saveerror', { error: 'capacity', pending: pendingPointCount() });
    emitPersistence();
  }
}

function emitPersistence() {
  rec.saveState.pending = pendingPointCount();
  emit('recorder:persistence', { ...rec.saveState });
  refreshQuality();
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
  return null;
}

function clearGeoRetry() {
  geoRetryTimer = clearTimer(geoRetryTimer);
  geoRetryAttempts = 0;
}

function scheduleGeoRetry() {
  if (geoRetryTimer || rec.status !== 'recording' || rec.simulated || rec.permissionDenied) return;
  const delay = Math.min(30_000, 3000 * 2 ** Math.min(geoRetryAttempts, 3));
  geoRetryAttempts++;
  geoRetryTimer = setTimeout(() => {
    geoRetryTimer = null;
    retryGeolocation();
  }, delay);
}

function resetSaveState() {
  flushAgain = false;
  rec.saveState = { pending: 0, lastSavedAt: 0, error: null, degraded: false };
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
    clearGeoRetry();
    lastWatchRestart = 0;
    rec.filteredCount = 0;
    rec.permissionDenied = false;
    rec.geoError = null;
    rec.lastFixWall = Date.now();
    rec.activityGuess = null;
    rec.activityClassification = null;
    let trip;
    if (tripId) {
      trip = await store.getTrip(tripId);
      if (!trip) return false;
    } else {
      trip = await store.createTrip({
        name: name || `${t('record.newTripName')} ${new Date().toLocaleString(languageTag(currentLang()))}`,
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
    resetActivityAndQuality();
    altSmooth = null; altRef = null;
    buffer = [];
    inflight = null;
    anchorT = 0; resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0;
    suspendFixIngest = false;
    resetSaveState();

    const seg = await store.addSegment(trip.id);
    rec.segmentId = seg.id;
    rec.live.segCount = await store.countTripSegments(trip.id);
    await store.updateTrip(trip.id, { status: 'recording' });

    if (!simulated && !startWatch()) throw new Error('geolocation unavailable');
    requestWakeLock();
    armKeepAlive();
    startTick();
    rec.status = 'recording';
    startQualityMonitoring();
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
      stopQualityMonitoring();
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
      rec.lastValidFixT = 0;
      rec.activityClassification = null;
      rec.quality = null;
      rec.tripActivity = 'auto';
      rec.simulated = false;
      rec.saveState = { pending: 0, lastSavedAt: 0, error: null, degraded: false };
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
    clearGeoRetry();
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    void pauseRecording();
    return;
  }
  const code = err.code === 2 ? 'unavailable' : 'timeout';
  if (rec.geoError !== code) {
    rec.geoError = code;
    emit('recorder:geoerror', { code });
  }
  scheduleGeoRetry();
}

function onGeoPosition(pos) {
  if (rec.status !== 'recording' || rec.simulated) return;
  clearGeoRetry();
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
    lastWatchRestart = Date.now();
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
    clearGeoRetry();
    emit('recorder:geoerror', { code: 'denied' });
    emit('recorder:denied');
    void pauseRecording();
    return;
  }
  geoRetryTimer = clearTimer(geoRetryTimer);
  rec.lastFixWall = Date.now();
  armResumeBreak();
  if (!startWatch()) {
    scheduleGeoRetry();
    return;
  }
  locateNow();
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
    activitySamples = [];
    rec.activityClassification = null;
    // A manual choice is authoritative. Switching back to auto starts fresh.
    rec.activityGuess = null;
    resetMotionFilter();
    emit('activity:classification', { classification: null, tripId: rec.tripId });
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

function noteValidFix(now: number, acc: number | null) {
  qualityValidFixes++;
  if (!qualityFirstFixT) qualityFirstFixT = now;
  qualityLastFixT = now;
  rec.lastValidFixT = now;
  if (acc != null && isFinite(acc) && acc > 0) {
    accuracySamples.push({ t: now, acc });
    accuracySamples = accuracySamples
      .filter((sample) => now - sample.t <= 120_000 && sample.t <= now)
      .slice(-240);
  }
}

function feedAutoActivity(sample: ActivitySample) {
  if (rec.tripActivity !== 'auto') return;
  activitySamples.push(sample);
  if (activitySamples.length > 400) activitySamples.shift();
  if (activitySamples.length < 6 || activitySamples.length % 5 !== 0) return;
  const classification = classifyActivityDetailed(activitySamples);
  rec.activityClassification = classification;
  emit('activity:classification', { classification, tripId: rec.tripId });
  if (classification.activity && classification.confidence >= ACTIVITY_CONFIDENCE_THRESHOLD
    && classification.activity !== rec.activityGuess) {
    rec.activityGuess = classification.activity;
    emit('activity:guess', {
      activity: rec.activityGuess,
      confidence: classification.confidence,
      classification,
      tripId: rec.tripId
    });
  }
}

function acceptPoint(fix, now, acc, fixSpeed, activity, dist = 0, dt = 0, implied = null) {
  const previousPoint = rec.lastPoint;
  if (pendingPointCount() >= MAX_PENDING_POINTS) {
    enterSaveDegraded();
    return false;
  }
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
  if (!qualityFirstPointT) qualityFirstPointT = now;
  qualityLastPointT = now;
  noteValidFix(now, acc);
  feedAutoActivity({
    t: now, speed: point.speed, distance: dist, dt,
    elevationChange: alt != null && previousPoint?.alt != null && isFinite(previousPoint.alt)
      ? alt - previousPoint.alt : null
  });
  emitPersistence();
  if (altPromise) {
    altPromise.then((res) => {
      if (res.alt == null) return;
      point.alt = res.alt; point.altSrc = res.src;
      if (point._flushed) patchFlushedAlt(point);
      else if (rec.live === L && (rec.status === 'recording' || rec.status === 'paused')) {
        if (altSmooth == null) altSmooth = res.alt;
        L.alt = res.alt; L.altSrc = res.src;
        emit('recorder:tick', { live: L });
      }
    });
  }
  if (buffer.length >= FLUSH_POINTS) void flushBuffer();
  else if (!flushTimer) flushTimer = setTimeout(flushBuffer, FLUSH_MS);
  emit('recorder:point', { point, live: L });
  return true;
}

async function processFix(fix) {
  if (rec.status !== 'recording' || suspendFixIngest) return;
  qualityObservedFixes++;
  const arrival = Date.now();
  const rawT = Number(fix?.t);
  const now = Number.isFinite(rawT) && rawT > 0 ? rawT : arrival;
  const rawLat = fix?.lat, rawLon = fix?.lon;
  if (rawLat == null || rawLon == null || rawLat === '' || rawLon === '') {
    qualityInvalidFixes++;
    refreshQuality();
    return;
  }
  const lat = Number(rawLat), lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    qualityInvalidFixes++;
    refreshQuality();
    return;
  }

  // Cached/queued fixes from before a suspension must never rewind the track.
  if ((rec.lastFixT && now <= rec.lastFixT) || arrival - now > STALE_FIX_MS) {
    qualityInvalidFixes++;
    refreshQuality();
    return;
  }
  if (pendingPointCount() >= MAX_PENDING_POINTS) {
    rec.lastFixWall = arrival;
    rec.filteredCount++;
    enterSaveDegraded();
    emit('recorder:filtered', { reason: 'storage', count: rec.filteredCount });
    return;
  }

  rec.lastFixWall = arrival;
  if (rec.geoError && rec.geoError !== 'denied') {
    rec.geoError = null;
    emit('recorder:geoerror', { code: null });
  }

  const accLimit = forceAccLimit || get('accuracyLimit');
  const rawAccuracy = fix?.acc == null || fix.acc === '' ? null : Number(fix.acc);
  if (rawAccuracy != null && (!Number.isFinite(rawAccuracy) || rawAccuracy <= 0 || rawAccuracy > accLimit)) {
    qualityInvalidFixes++;
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'accuracy', count: rec.filteredCount });
    refreshQuality();
    return;
  }
  if (!rec.firstFixT) rec.firstFixT = now;
  rec.lastFixT = now;

  const acc = rawAccuracy != null && Number.isFinite(rawAccuracy) ? rawAccuracy : null;
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
  qualityInvalidFixes += decision.discarded?.length || 0;
  if (decision.action === 'pending') {
    rec.filteredCount++;
    emit('recorder:filtered', { reason: 'jump', count: rec.filteredCount });
    refreshQuality();
    return;
  }
  if (decision.action === 'confirm') {
    const first = decision.points[0];
    const jumpDist = haversine(rec.lastPoint.lat, rec.lastPoint.lon, first.lat, first.lon);
    const jumpDt = first.t - (anchorT || rec.lastPoint.t);
    if (!(await beginNewSegment(first.t, { dist: Math.round(jumpDist), dt: Math.round(jumpDt), auto: true }, 'record.geoRelocated'))) return;
    let confirmed = 0;
    let previous = null;
    for (const candidate of decision.points) {
      let cDist = 0, cDt = 0, cImplied = null;
      if (previous) {
        cDist = haversine(previous.lat, previous.lon, candidate.lat, candidate.lon);
        cDt = candidate.t - previous.t;
        if (cDt > 0) cImplied = cDist / (cDt / 1000);
      }
      const candidateActivity = rec.tripActivity === 'auto' ? (rec.activityGuess || 'auto') : rec.tripActivity;
      if (acceptPoint(candidate, candidate.t, candidate.acc ?? null, candidate.speed ?? null, candidateActivity, cDist, cDt, cImplied)) confirmed++;
      else break;
      previous = rec.lastPoint;
    }
    rec.filteredCount = Math.max(0, rec.filteredCount - confirmed);
    return;
  }

  if (rec.lastPoint) {
    const avgAcc = acc != null && rec.lastPoint.acc != null ? (acc + rec.lastPoint.acc) / 2 : (acc ?? rec.lastPoint.acc ?? 15);
    const deadband = Math.max(4, Math.min(20, avgAcc * 1.2));
    if (dist < deadband) {
      if (dt > 0 && dt <= 60_000) {
        rec.live.activeMs += dt;
        const observedSpeed = fixSpeed ?? implied;
        if (observedSpeed != null && observedSpeed > MOVING_SPEED && observedSpeed <= physicsFor('travel').vmax * 1.3) rec.live.movingMs += dt;
        else rec.live.stillMs += dt;
      }
      anchorT = now;
      const sampleSpeed = fixSpeed != null && fixSpeed <= physicsFor('travel').vmax * 1.3
        ? fixSpeed
        : implied != null && implied <= physicsFor('travel').vmax * 1.3 ? implied : null;
      rec.live.speed = sampleSpeed;
      rec.live.acc = acc;
      rec.live.lat = lat; rec.live.lon = lon;
      rec.live.heading = fix.heading != null && isFinite(fix.heading) ? fix.heading : null;
      noteValidFix(now, acc);
      const sampleAlt = fix.alt != null && isFinite(fix.alt) && fix.altAcc != null && fix.altAcc <= 30 ? fix.alt : null;
      feedAutoActivity({
        t: now, speed: sampleSpeed, distance: dist, dt,
        elevationChange: sampleAlt != null && rec.lastPoint?.alt != null && isFinite(rec.lastPoint.alt)
          ? sampleAlt - rec.lastPoint.alt : null
      });
      refreshQuality();
      emit('recorder:tick', { live: rec.live, quality: rec.quality });
      return;
    }
    if (dt > GAP_TIME) {
      if (!(await beginNewSegment(now, { dist: Math.round(dist), dt: Math.round(dt) }, 'record.gapNewSegment'))) return;
      dist = 0; dt = 0; implied = null;
    }
  }

  acceptPoint(fix, now, acc, fixSpeed, activity, dist, dt, implied);
}


function patchFlushedAlt(point) {
  patchFlushedAltitude(point._segmentId, point).catch(() => { /* non-critical */ });
}

export function flushBuffer() {
  flushTimer = clearTimer(flushTimer);
  if (flushRunning) {
    flushAgain = true;
    return flushChain;
  }
  flushRunning = true;
  const run = flushChain.then(runFlushLoop, runFlushLoop).catch((e) => {
    flushAgain = false;
    console.error('flush crashed', e);
    return false;
  }).finally(() => {
    flushRunning = false;
    if (flushAgain) void flushBuffer();
  });
  flushChain = run;
  return run;
}

async function runFlushLoop() {
  let ok = true;
  do {
    flushAgain = false;
    ok = await doFlush();
    if (!ok) {
      flushAgain = false;
      break;
    }
  } while (flushAgain || buffer.length);
  return ok;
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
    const pending = pendingPointCount();
    rec.saveState.error = pending >= MAX_PENDING_POINTS ? 'capacity' : null;
    rec.saveState.degraded = pending >= MAX_PENDING_POINTS;
    rec.saveState.lastSavedAt = Date.now();
    if (!pending) clearSpill(segId);
    emit('recorder:saved', { count: pts.length });
    emitPersistence();
    return true;
  } catch (e) {
    console.error('flush failed', e);
    inflight = null;
    buffer.unshift(...pts);
    const pending = pendingPointCount();
    rec.saveState.error = pending >= MAX_PENDING_POINTS ? 'capacity' : 'write';
    rec.saveState.degraded = pending >= MAX_PENDING_POINTS;
    emit('recorder:saveerror', { error: rec.saveState.error, pending });
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
    const seg = await store.getSegment(data.segmentId);
    if (!seg || seg.tripId !== data.tripId) {
      localStorage.removeItem(SPILL_KEY);
      return 0;
    }
    const lastT = (await store.loadLastTrackTimestamp(data.segmentId)) ?? -Infinity;
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
        if (!geoRetryTimer && Date.now() - lastWatchRestart > 5000) retryGeolocation();
      }
      refreshQuality(false);
      emit('recorder:tick', { live: rec.live, quality: rec.quality });
    }
  }, 1000);
}
function stopTick() { if (tickTimer) { clearInterval(tickTimer); tickTimer = null; } }

export async function pauseRecording() {
  if (rec.status !== 'recording') return false;
  clearGeoRetry();
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
  const pauseTime = Date.now();
  if (qualityActiveStartedAt) {
    qualityActiveElapsedMs += Math.max(0, pauseTime - qualityActiveStartedAt);
    qualityActiveStartedAt = 0;
  }
  qualityPausedSpans.push({ start: pauseTime, end: null });
  rec.status = 'paused';
  stopQualityMonitoring();
  suspendFixIngest = false;
  pausedAt = pauseTime;
  resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
  await store.updateTrip(rec.tripId, { status: 'paused' }).catch((e) => console.error('trip status update failed', e));
  rec.saveState.pending = 0;
  rec.saveState.error = null;
  rec.saveState.degraded = false;
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
    const resumeTime = Date.now();
    const openPause = qualityPausedSpans[qualityPausedSpans.length - 1];
    if (openPause && openPause.end == null) openPause.end = resumeTime;
    qualityActiveStartedAt = resumeTime;
    clearGeoRetry();
    lastWatchRestart = 0;
    rec.startedAt = Date.now() - (rec.live?.duration || 0);
    rec.permissionDenied = false;
    rec.geoError = null;
    rec.lastFixWall = Date.now();
    qualitySegmentStartedAt = resumeTime;
    resetMotionFilter(); breakOnNextFix = false; forceAccLimit = 0; anchorT = 0;
    suspendFixIngest = false;
    await store.updateTrip(rec.tripId, { status: 'recording' }).catch((e) => console.error('trip status update failed', e));
    if (!rec.simulated && !startWatch()) {
      const failedAt = Date.now();
      if (qualityActiveStartedAt) {
        qualityActiveElapsedMs += Math.max(0, failedAt - qualityActiveStartedAt);
        qualityActiveStartedAt = 0;
      }
      qualityPausedSpans.push({ start: failedAt, end: null });
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
    startQualityMonitoring();
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
  clearGeoRetry();
  suspendFixIngest = true;
  stopWatch();
  stopTick();
  stopQualityMonitoring();
  await fixChain.catch(() => {});
  if (!(await flushBuffer())) {
    suspendFixIngest = false;
    rec.lastFixWall = Date.now();
    startTick();
    startQualityMonitoring();
    if (!rec.simulated) {
      armResumeBreak();
      startWatch();
      locateNow();
    }
    return null;
  }
  try {
    // pause/resume without fixes leaves empty segments — prune them at stop
    await store.pruneEmptySegments(rec.tripId);
    if (rec.tripId) {
      const tr = await store.getTrip(rec.tripId);
      let finalActivity = null;
      const selectedActivity = rec.tripActivity || tr?.activity || 'auto';
      if (selectedActivity === 'auto') {
        const finalClassification = classifyActivityDetailed(activitySamples);
        rec.activityClassification = finalClassification;
        // Low confidence keeps the last confident guess, or leaves the trip auto.
        finalActivity = finalClassification.activity || rec.activityGuess;
      } else {
        // A manual selection is authoritative even if its earlier write failed.
        finalActivity = selectedActivity;
      }
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
    rec.saveState.degraded = false;
    emitPersistence();
    const id = rec.tripId;
    rec.tripId = null; rec.segmentId = null; rec.live = null; rec.lastPoint = null;
    rec.lastValidFixT = 0; rec.quality = null; rec.activityClassification = null; rec.tripActivity = 'auto';
    return id;
  } catch (e) {
    console.error('stop failed', e);
    rec.status = 'paused';
    rec.saveState.error = 'finalize';
    rec.saveState.degraded = false;
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
    rec.tripActivity = trip.activity || 'auto';
    rec.live = freshLive();
    resetActivityAndQuality();
    // rebuild live counters from stored data
    const full = await store.loadTripTrack(tripId);
    const st = await computeStatsSummaryAsync(full.segments, {
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
    stopQualityMonitoring();
    rec.quality = null;
    releaseRecorderLock();
    throw e;
  }
}

/** Find trips left in recording/paused state (crash / kill recovery). */
export async function findRecoverableTrip() {
  const all = await store.listTrips();
  return all.find((tr) => tr.status === 'recording' || tr.status === 'paused') || null;
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
    if (rec.status === 'recording' && !rec.simulated) retryGeolocation();
    if (gapMs > BG_NOTICE_MS) {
      emit('recorder:background', { gapMs, silentMs, autoBreak: breakOnNextFix });
    }
  }
});

function recoverRecordingLocation() {
  if (document.visibilityState !== 'visible' || rec.status !== 'recording' || rec.simulated) return;
  if (rec.geoError || Date.now() - (rec.lastFixWall || rec.startedAt) > SILENT_MS) retryGeolocation();
}
window.addEventListener('online', recoverRecordingLocation);
window.addEventListener('focus', recoverRecordingLocation);