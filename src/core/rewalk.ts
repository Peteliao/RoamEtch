// Re-walk navigation: follow a reference trip forwards or backwards, join it
// midway, or get guided to an endpoint when off route. Live GPS drives a small
// phase machine — locating → approach → follow → finished.
import { loadTripFull } from './store';
import { haversine, bearing, fmtDistance, fmtDuration } from './geo';
import { emit } from './events';
import { t, currentLang } from './i18n';
import { get, set } from './settings';
import { rec } from './recorder';
import { navigationLinks, type NavigationLinks, type NavigationPlatform } from './navigation';

export const EXTERNAL_NAV_MIN_M = 1000;
const APPROACH_BANDS = [20, 50, 100, 200, 500, 1000];
const ARRIVE_M = 60;
const NEAR_M = 150;
const OFF_M = 60;
const JOIN_M = 150;           // snap onto the track within this distance
const TARGET_ARRIVE_M = 35;   // reached the route start / selected endpoint
const FOLLOW_WINDOW = 600;    // keep nearest-point search local once following
const OFF_EXIT_M = 45;        // hysteresis prevents GPS jitter from re-entering
const OFF_DT_CAP_MS = 5000;   // never credit a suspended/batched GPS gap in full
const OFF_ANNOUNCE_MS = 10_000;
const OFF_REPEAT_MS = 30_000;
const TURN_LOOKAHEAD_M = 250;
const TURN_MIN_DEG = 45;
const MIN_ETA_SPEED_MPS = 0.3;
const MAX_ETA_SPEED_MPS = 70;
const MAX_SPEED_DT_MS = 15_000;
const SPEED_EWMA_ALPHA = 0.35;

export type RewalkMode = 'full-fwd' | 'full-rev' | 'near-end' | 'near-start';
export type RewalkPhase = 'locating' | 'approach' | 'follow' | 'finished';
export type RewalkEtaSource = 'gps' | 'recent' | 'historical' | null;
export type RewalkTurnDirection = 'left' | 'right' | 'uturn';

export interface RewalkSegmentRange {
  start: number;
  end: number;
}

export interface RewalkProjection {
  idx: number;
  edgeIdx: number;
  segmentIndex: number;
  dist: number;
  along: number;
  lat: number;
  lon: number;
  fraction: number;
}

export interface RewalkTurn {
  id: string;
  direction: RewalkTurnDirection;
  distanceM: number;
  alongM: number;
  idx: number;
  fromBearing: number;
  toBearing: number;
  deltaDeg: number;
  angleDeg: number;
  isNew: boolean;
}

interface RouteTurn extends Omit<RewalkTurn, 'distanceM' | 'isNew'> {}

interface FixState {
  lat: number;
  lon: number;
  acc: any;
  heading: any;
  t: number | null;
  speed: number | null;
}

interface TimedFix {
  lat: number;
  lon: number;
  t: number;
}

const MODE_KEYS: Record<RewalkMode, string> = {
  'full-fwd': 'modeFullFwd',
  'full-rev': 'modeFullRev',
  'near-end': 'modeToEnd',
  'near-start': 'modeToStart'
};

export const rewalk = {
  active: false, tripId: null, name: '', mode: 'full-fwd' as RewalkMode,
  pts: [], cum: [], total: 0, segmentRanges: [] as RewalkSegmentRange[], routeTurns: [] as RouteTurn[],
  idx: 0, maxIdx: 0, entryIdx: 0, entryAlong: 0, along: 0, maxAlong: 0,
  projection: null as RewalkProjection | null, offTrack: 0,
  phase: 'locating' as RewalkPhase,
  targetType: 'end' as 'start' | 'end',
  navTarget: null as null | { id?: string; lat: number; lon: number },
  navTargetType: null as null | 'start' | 'end',
  navBearing: null as number | null, routeBearing: null as number | null,
  etaSeconds: null as number | null, etaSource: null as RewalkEtaSource, etaEstimated: false,
  speedMps: null as number | null, speedSource: null as RewalkEtaSource,
  recentSpeedMps: null as number | null, recentSpeedT: null as number | null,
  historicalSpeedMps: null as number | null,
  turn: null as RewalkTurn | null,
  offRoute: false, offRouteForMs: 0, offRouteSinceT: null as number | null,
  lastOffFixT: null as number | null,
  lastFix: null as FixState | null, lastFixT: null as number | null, lastTimedFix: null as TimedFix | null,
  finished: false, departed: false, muted: false, sim: false, wps: [],
  announced: new Set(), nearAnnounced: new Set(), announcedTurns: new Set<string>(),
  externalNav: false, approachBand: null as number | null,
  watchId: null, simTimer: null, simPos: null as null | { lat: number; lon: number },
  simDist: 0, lastOffAnnounce: null as number | null
};

let speechPrimed = false;
let rewalkRequest = 0;

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
  if (rewalk.externalNav || rewalk.muted || get('rewalkVoice') === false || !text || !('speechSynthesis' in window)) return;
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

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function normalizeLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function safeBearing(lat1, lon1, lat2, lon2) {
  if (!validLatLon(lat1, lon1) || !validLatLon(lat2, lon2)) return null;
  if (haversine(lat1, lon1, lat2, lon2) < 1e-6) return null;
  const value = bearing(lat1, lon1, lat2, lon2);
  return Number.isFinite(value) ? (value + 360) % 360 : null;
}

function samePoint(a, b) {
  return !!a && !!b && haversine(a.lat, a.lon, b.lat, b.lon) < 1e-6;
}

export function buildRoute(segments, reverse = false) {
  const ordered = reverse ? (segments || []).slice().reverse() : (segments || []);
  const pts = [], cum = [0], segmentRanges: RewalkSegmentRange[] = [];
  for (const segment of ordered) {
    const source = (segment?.points || []).filter((p) => validLatLon(p?.lat, p?.lon));
    if (reverse) source.reverse();
    if (!source.length) continue;
    const start = pts.length;
    if (start > 0) cum.push(cum[start - 1]); // a segment boundary is not a route edge
    // Spreading a long recording segment can exceed the engine's argument limit.
    for (const point of source) pts.push(point);
    for (let i = 1; i < source.length; i++) {
      cum.push(cum[start + i - 1] + haversine(source[i - 1].lat, source[i - 1].lon, source[i].lat, source[i].lon));
    }
    segmentRanges.push({ start, end: pts.length - 1 });
  }
  return { pts, cum, segmentRanges, total: cum[cum.length - 1] || 0 };
}

/** Project onto actual segment interiors; boundaries never create synthetic edges. */
function nearestProjection(lat, lon, pts, cum, segmentRanges, hint = -1): RewalkProjection | null {
  if (!validLatLon(lat, lon) || !pts.length || !segmentRanges.length) return null;
  let from = 0, to = pts.length - 1;
  if (hint >= 0 && pts.length > FOLLOW_WINDOW * 2) {
    from = Math.max(0, hint - FOLLOW_WINDOW);
    to = Math.min(pts.length - 1, hint + FOLLOW_WINDOW);
  }
  const rad = (d) => (d * Math.PI) / 180;
  const R = 6371008.8;
  const lat0 = rad((lat + pts[from].lat + pts[to].lat) / 3);
  const lonScale = R * Math.max(1e-6, Math.cos(lat0));
  const xy = (p) => [rad(normalizeLon(p.lon - lon)) * lonScale, rad(p.lat - lat) * R];
  let best: RewalkProjection | null = null, bestHintDistance = Infinity;

  for (let segmentIndex = 0; segmentIndex < segmentRanges.length; segmentIndex++) {
    const range = segmentRanges[segmentIndex];
    if (range.end < from || range.start > to) continue;
    for (let i = range.start; i < range.end; i++) {
      const a = pts[i], b = pts[i + 1];
      const [ax, ay] = xy(a), [bx, by] = xy(b);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      const fraction = len2 > 1e-12 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      const pLat = a.lat + (b.lat - a.lat) * fraction;
      const pLon = normalizeLon(a.lon + normalizeLon(b.lon - a.lon) * fraction);
      const dist = haversine(lat, lon, pLat, pLon);
      const idx = fraction < 0.5 ? i : i + 1;
      const hintDistance = hint >= 0 ? Math.abs(idx - hint) : i;
      if (best && (dist > best.dist + 1e-6 || (Math.abs(dist - best.dist) <= 1e-6 && hintDistance >= bestHintDistance))) continue;
      best = {
        idx, edgeIdx: i, segmentIndex, dist,
        along: cum[i] + (cum[i + 1] - cum[i]) * fraction,
        lat: pLat, lon: pLon, fraction
      };
      bestHintDistance = hintDistance;
    }
    if (range.start === range.end) {
      const p = pts[range.start], dist = haversine(lat, lon, p.lat, p.lon);
      const hintDistance = hint >= 0 ? Math.abs(range.start - hint) : range.start;
      if (!best || dist < best.dist - 1e-6 || (Math.abs(dist - best.dist) <= 1e-6 && hintDistance < bestHintDistance)) {
        best = { idx: range.start, edgeIdx: range.start, segmentIndex, dist, along: cum[range.start], lat: p.lat, lon: p.lon, fraction: 0 };
        bestHintDistance = hintDistance;
      }
    }
  }
  return best;
}

function routeBearingAt(projection: RewalkProjection | null, pts, cum, segmentRanges) {
  if (!projection) return null;
  const range = segmentRanges[projection.segmentIndex];
  if (!range) return null;
  if (projection.edgeIdx < range.end && cum[projection.edgeIdx + 1] - projection.along > 1e-6) {
    const next = pts[projection.edgeIdx + 1];
    return safeBearing(projection.lat, projection.lon, next.lat, next.lon);
  }
  // At a vertex, face the next real edge in this segment, never a gap bridge.
  for (let i = projection.idx + 1; i <= range.end; i++) {
    const from = pts[i - 1];
    if (!samePoint(from, pts[i])) return safeBearing(from.lat, from.lon, pts[i].lat, pts[i].lon);
  }
  return null;
}

function buildRouteTurns(pts, cum, segmentRanges): RouteTurn[] {
  const turns: RouteTurn[] = [];
  segmentRanges.forEach((range, segmentIndex) => {
    const nodes: Array<{ idx: number; point: any }> = [];
    for (let i = range.start; i <= range.end; i++) {
      if (!nodes.length || !samePoint(nodes[nodes.length - 1].point, pts[i])) nodes.push({ idx: i, point: pts[i] });
    }
    for (let i = 1; i < nodes.length - 1; i++) {
      const prev = nodes[i - 1].point, point = nodes[i].point, next = nodes[i + 1].point;
      const fromBearing = safeBearing(prev.lat, prev.lon, point.lat, point.lon);
      const toBearing = safeBearing(point.lat, point.lon, next.lat, next.lon);
      if (fromBearing == null || toBearing == null) continue;
      const deltaDeg = ((toBearing - fromBearing + 540) % 360) - 180;
      const angleDeg = Math.abs(deltaDeg);
      if (angleDeg < TURN_MIN_DEG) continue;
      const direction: RewalkTurnDirection = angleDeg >= 135 ? 'uturn' : deltaDeg > 0 ? 'right' : 'left';
      const alongM = cum[nodes[i].idx];
      const previous = turns[turns.length - 1];
      if (previous && Math.abs(previous.alongM - alongM) < 1 && previous.direction === direction) continue;
      turns.push({
        id: `turn:${segmentIndex}:${nodes[i].idx}`, direction, alongM,
        idx: nodes[i].idx, fromBearing, toBearing, deltaDeg, angleDeg
      });
    }
  });
  return turns;
}

function historicalSpeed(full, total) {
  const trip = full?.trip || {}, stats = trip.statsCache || {};
  const distance = [stats.distance, trip.reportedDistance, trip.distance, total]
    .find((value) => Number.isFinite(value) && value >= 0);
  const movingMs = [stats.movingMs, trip.movingMs].find((value) => Number.isFinite(value) && value > 0);
  if (!(distance > 0) || !movingMs) return null;
  const speed = distance / (movingMs / 1000);
  return speed >= MIN_ETA_SPEED_MPS && speed <= MAX_ETA_SPEED_MPS ? speed : null;
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

function localizedEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const unit = total < 60 ? 'second' : total < 3600 ? 'minute' : 'hour';
  const value = Math.max(1, Math.round(total / (unit === 'second' ? 1 : unit === 'minute' ? 60 : 3600)));
  const zh = String(currentLang()).toLowerCase().startsWith('zh');
  try {
    const text = new Intl.RelativeTimeFormat(zh ? 'zh-CN' : 'en-US', { numeric: 'always' }).format(value, unit);
    return zh ? text.replace(/后$/, '') : text.replace(/^in\s+/i, '');
  } catch {
    return fmtDuration(seconds * 1000, { compact: true });
  }
}

function currentSpeedMps(): number | null {
  return normalizeGpsSpeed(rewalk.lastFix?.speed)
    ?? rewalk.recentSpeedMps
    ?? rewalk.historicalSpeedMps;
}

function etaSecondsFor(distanceM: number): number | null {
  if (distanceM <= 0) return 0;
  const speed = currentSpeedMps();
  return speed != null && speed > 0 ? Math.round(distanceM / speed) : null;
}

export async function startRewalk(tripId, mode: RewalkMode = 'full-fwd') {
  primeSpeech();
  if (rec.status === 'recording' || rec.status === 'paused') return 'busy';
  if (rewalk.active) stopRewalk();
  const request = ++rewalkRequest;
  if (!MODE_KEYS[mode]) mode = 'full-fwd';
  const full = await loadTripFull(tripId);
  if (request !== rewalkRequest || rec.status === 'recording' || rec.status === 'paused') return 'cancelled';
  const origRoute = buildRoute(full?.segments);
  const orig = origRoute.pts;
  if (orig.length < 2) return 'empty';

  const reverse = mode === 'full-rev' || mode === 'near-start';
  const route = buildRoute(full.segments, reverse);
  const pts = route.pts, cum = route.cum, total = route.total;

  const wps = (full.waypoints || []).filter((w) => !w.hidden).map((w) => {
    const projection = nearestProjection(w.lat, w.lon, origRoute.pts, origRoute.cum, origRoute.segmentRanges);
    const along = projection?.along ?? 0;
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
    pts, cum, total, segmentRanges: route.segmentRanges, routeTurns: buildRouteTurns(pts, cum, route.segmentRanges),
    idx: 0, maxIdx: 0, entryIdx: 0, entryAlong: 0, along: 0, maxAlong: 0,
    projection: null, offTrack: 0,
    phase: 'locating' as RewalkPhase,
    targetType: (mode === 'full-rev' || mode === 'near-start') ? 'start' : 'end',
    navTarget: null, navTargetType: null, navBearing: null, routeBearing: null,
    etaSeconds: null, etaSource: null, etaEstimated: false, speedMps: null, speedSource: null,
    recentSpeedMps: null, recentSpeedT: null, historicalSpeedMps: historicalSpeed(full, total),
    turn: null, offRoute: false, offRouteForMs: 0, offRouteSinceT: null, lastOffFixT: null,
    lastFix: null, lastFixT: null, lastTimedFix: null, simPos: null,
    finished: false, departed: false, muted: get('rewalkVoice') === false, wps,
    announced: new Set(), nearAnnounced: new Set(), announcedTurns: new Set<string>(),
    externalNav: false, approachBand: null,
    simDist: 0, lastOffAnnounce: null
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
    (pos) => feedFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy, pos.coords.heading, pos.coords.speed, pos.timestamp),
    (err) => emit('rewalk:geoerror', { code: err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'timeout' }),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}
function stopWatch() {
  if (rewalk.watchId != null) { navigator.geolocation?.clearWatch(rewalk.watchId); rewalk.watchId = null; }
}

function beginFollow(idx, announceJoin, projection: RewalkProjection | null = null) {
  const along = projection?.along ?? rewalk.cum[idx] ?? 0;
  rewalk.phase = 'follow';
  rewalk.entryIdx = idx;
  rewalk.entryAlong = along;
  rewalk.idx = idx;
  rewalk.maxIdx = idx;
  rewalk.along = along;
  rewalk.maxAlong = along;
  rewalk.projection = projection;
  rewalk.offTrack = projection?.dist ?? 0;
  rewalk.offRoute = false;
  rewalk.offRouteForMs = 0;
  rewalk.offRouteSinceT = null;
  rewalk.lastOffFixT = null;
  rewalk.departed = false;
  rewalk.navTarget = null;
  rewalk.navTargetType = null;
  rewalk.navBearing = null;
  rewalk.routeBearing = routeBearingAt(projection, rewalk.pts, rewalk.cum, rewalk.segmentRanges);
  rewalk.turn = null;
  rewalk.externalNav = false;
  rewalk.approachBand = null;
  if (announceJoin) speak(t('rewalk.joinAnnounce'));
}

function approachBand(distanceM: number) {
  return APPROACH_BANDS.find((band) => distanceM <= band) ?? null;
}

function directionKey(degrees: number) {
  const keys = ['north', 'northEast', 'east', 'southEast', 'south', 'southWest', 'west', 'northWest'];
  return keys[Math.round(((degrees % 360) + 360) % 360 / 45) % 8];
}

function beginApproach(target, fromLat, fromLon) {
  rewalk.phase = 'approach';
  rewalk.navTarget = { lat: target.lat, lon: target.lon };
  rewalk.navTargetType = rewalk.mode === 'full-fwd' ? 'start' : rewalk.mode === 'full-rev' ? 'end' : rewalk.targetType;
  rewalk.navBearing = safeBearing(fromLat, fromLon, target.lat, target.lon);
  rewalk.routeBearing = null;
  rewalk.turn = null;
  const d = haversine(fromLat, fromLon, target.lat, target.lon);
  rewalk.approachBand = approachBand(d);
  if (rewalk.approachBand != null) {
    speak(t('rewalk.approachGuide', {
      target: approachLabel(), dist: distText(d), direction: t(`rewalk.directions.${directionKey(rewalk.navBearing ?? 0)}`)
    }));
  } else {
    speak(t('rewalk.approachAnnounce', { target: approachLabel(), dist: distText(d) }));
  }
}

function locate(lat, lon) {
  if (rewalk.mode === 'full-fwd' || rewalk.mode === 'full-rev') {
    const start = rewalk.pts[0];
    const d = haversine(lat, lon, start.lat, start.lon);
    if (d <= JOIN_M) beginFollow(0, false);
    else beginApproach(start, lat, lon);
    return;
  }
  const projection = nearestProjection(lat, lon, rewalk.pts, rewalk.cum, rewalk.segmentRanges);
  if (projection && projection.dist <= JOIN_M) {
    beginFollow(projection.idx, false, projection);
  } else {
    const target = rewalk.pts[rewalk.pts.length - 1];
    beginApproach(target, lat, lon);
  }
}

function finish() {
  if (rewalk.finished) return;
  rewalk.finished = true;
  rewalk.phase = 'finished';
  rewalk.externalNav = false;
  rewalk.navBearing = null;
  rewalk.routeBearing = null;
  rewalk.turn = null;
  stopWatch();
  stopSim();
  speak(t(rewalk.targetType === 'start' ? 'rewalk.voiceArriveStart' : 'rewalk.voiceArriveEnd'));
  emit('rewalk:finished', { total: rewalk.total, targetType: rewalk.targetType, mode: rewalk.mode });
}

function normalizeGpsSpeed(speed) {
  return Number.isFinite(speed) && speed >= 0 && speed <= MAX_ETA_SPEED_MPS ? speed : null;
}

function updateSpeedState(lat, lon, speed, t) {
  if (t == null) {
    rewalk.lastTimedFix = null;
    rewalk.recentSpeedMps = null;
    rewalk.recentSpeedT = null;
    return;
  }
  const previous = rewalk.lastTimedFix;
  if (previous) {
    const dt = t - previous.t;
    if (dt > MAX_SPEED_DT_MS) {
      rewalk.recentSpeedMps = null;
      rewalk.recentSpeedT = null;
    } else if (dt > 0) {
      const dist = haversine(previous.lat, previous.lon, lat, lon);
      const implied = dist / (dt / 1000);
      if (implied >= MIN_ETA_SPEED_MPS && implied <= MAX_ETA_SPEED_MPS) {
        rewalk.recentSpeedMps = rewalk.recentSpeedMps == null
          ? implied : SPEED_EWMA_ALPHA * implied + (1 - SPEED_EWMA_ALPHA) * rewalk.recentSpeedMps;
        rewalk.recentSpeedT = t;
      } else if (implied > MAX_ETA_SPEED_MPS) {
        rewalk.recentSpeedMps = null;
        rewalk.recentSpeedT = null;
      }
    }
  }
  if (rewalk.recentSpeedT != null && t - rewalk.recentSpeedT > MAX_SPEED_DT_MS) {
    rewalk.recentSpeedMps = null;
    rewalk.recentSpeedT = null;
  }
  rewalk.lastTimedFix = { lat, lon, t };
}

function updateOffRoute(dist, timestamp) {
  if (rewalk.phase !== 'follow') return false;
  if (!rewalk.offRoute) {
    if (dist <= OFF_M) return false;
    rewalk.offRoute = true;
    rewalk.offRouteForMs = 0;
    rewalk.offRouteSinceT = timestamp;
    rewalk.lastOffFixT = timestamp;
    return false;
  }
  if (dist <= OFF_EXIT_M) {
    rewalk.offRoute = false;
    rewalk.offRouteForMs = 0;
    rewalk.offRouteSinceT = null;
    rewalk.lastOffFixT = null;
    rewalk.lastOffAnnounce = null;
    return false;
  }
  if (timestamp == null) {
    rewalk.lastOffFixT = null;
    return false;
  }
  if (rewalk.lastOffFixT != null) {
    rewalk.offRouteForMs += Math.min(OFF_DT_CAP_MS, Math.max(0, timestamp - rewalk.lastOffFixT));
  }
  rewalk.lastOffFixT = timestamp;
  if (rewalk.offRouteForMs < OFF_ANNOUNCE_MS) return false;
  if (rewalk.lastOffAnnounce != null && timestamp - rewalk.lastOffAnnounce < OFF_REPEAT_MS) return false;
  rewalk.lastOffAnnounce = timestamp;
  speak(t('rewalk.offAnnounce'));
  return true;
}

function updateTurn(along) {
  const upcoming = rewalk.routeTurns.find((candidate) => candidate.alongM > along + 0.5 && candidate.alongM - along <= TURN_LOOKAHEAD_M);
  if (!upcoming) {
    rewalk.turn = null;
    return;
  }
  const isNew = !rewalk.announcedTurns.has(upcoming.id);
  rewalk.announcedTurns.add(upcoming.id);
  const distanceM = Math.max(0, upcoming.alongM - along);
  rewalk.turn = { ...upcoming, distanceM, isNew };
  if (isNew) {
    speak(t('rewalk.turnAnnounce', {
      turn: t(`rewalk.turn${upcoming.direction[0].toUpperCase()}${upcoming.direction.slice(1)}`),
      distance: distText(distanceM)
    }));
  }
}

function updateEta(remaining) {
  let source: RewalkEtaSource = null, speed: number | null = null;
  const gpsSpeed = normalizeGpsSpeed(rewalk.lastFix?.speed);
  if (gpsSpeed != null) {
    source = 'gps';
    speed = gpsSpeed;
  } else if (rewalk.recentSpeedMps != null) {
    source = 'recent';
    speed = rewalk.recentSpeedMps;
  } else if (rewalk.historicalSpeedMps != null) {
    source = 'historical';
    speed = rewalk.historicalSpeedMps;
  }
  rewalk.speedMps = speed;
  rewalk.speedSource = source;
  rewalk.etaSource = source;
  rewalk.etaEstimated = source === 'recent' || source === 'historical';
  rewalk.etaSeconds = etaSecondsFor(remaining);
}

function emission(lat, lon, acc, heading, offRouteAnnounce = false) {
  const along = rewalk.along;
  const span = Math.max(1e-6, rewalk.total - rewalk.entryAlong);
  const inFollow = rewalk.phase === 'follow' || rewalk.phase === 'finished';
  const progress = inFollow ? Math.max(0, Math.min(1, (along - rewalk.entryAlong) / span)) : 0;
  const target = rewalk.navTarget || rewalk.pts[rewalk.pts.length - 1];
  const remaining = rewalk.phase === 'approach'
    ? haversine(lat, lon, target.lat, target.lon)
    : Math.max(0, rewalk.total - along);
  updateEta(remaining);
  const nextWp = rewalk.wps.find((w) => w.distAlong > along + 5) || null;
  const nextWpDist = nextWp ? Math.max(0, nextWp.distAlong - along) : null;
  emit('rewalk:fix', {
    idx: rewalk.idx, lat, lon, acc, heading, offTrack: rewalk.offTrack,
    along, progress, remaining, phase: rewalk.phase, mode: rewalk.mode,
    targetType: rewalk.targetType, navTargetType: rewalk.navTargetType,
    targetLat: target?.lat, targetLon: target?.lon,
    navDist: rewalk.phase === 'approach' ? remaining : null,
    navBearing: rewalk.navBearing, routeBearing: rewalk.routeBearing,
    etaSeconds: rewalk.etaSeconds, etaSource: rewalk.etaSource, etaEstimated: rewalk.etaEstimated,
    speedMps: rewalk.speedMps, speedSource: rewalk.speedSource,
    turn: rewalk.turn, offRoute: rewalk.offRoute, offRouteForMs: rewalk.offRouteForMs,
    offRouteAnnounce,
    externalNav: rewalk.externalNav,
    nextWp: nextWp ? {
      name: nextWp.name || wpLabel(nextWp), type: nextWp.type, dist: nextWpDist,
      bearing: safeBearing(lat, lon, nextWp.lat, nextWp.lon), etaSeconds: etaSecondsFor(nextWpDist)
    } : null,
    finished: rewalk.finished
  });
}

/** Central fix pipeline — also fed by the walk simulator. */
export function feedFix(lat, lon, acc = null, heading = null, speed = null, timestamp = null) {
  if (!rewalk.active || !validLatLon(lat, lon)) return;
  const fixT = Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
  if (fixT != null && rewalk.lastFixT != null && fixT < rewalk.lastFixT) return;

  updateSpeedState(lat, lon, speed, fixT);
  if (fixT != null) rewalk.lastFixT = fixT;
  rewalk.lastFix = { lat, lon, acc, heading, t: fixT, speed: normalizeGpsSpeed(speed) };
  if (rewalk.phase === 'locating') locate(lat, lon);
  if (rewalk.phase === 'approach' && rewalk.navTarget) {
    const target = rewalk.navTarget;
    const d = haversine(lat, lon, target.lat, target.lon);
    rewalk.navBearing = safeBearing(lat, lon, target.lat, target.lon);
    if (d <= TARGET_ARRIVE_M) {
      if (rewalk.mode === 'full-fwd' || rewalk.mode === 'full-rev') beginFollow(0, true);
      else finish();
    }
    if (rewalk.phase === 'approach') {
      const band = approachBand(d);
      if (band != null && band !== rewalk.approachBand) {
        rewalk.approachBand = band;
        speak(t('rewalk.approachGuide', {
          target: approachLabel(), dist: distText(d), direction: t(`rewalk.directions.${directionKey(rewalk.navBearing ?? 0)}`)
        }));
      } else if (band == null) {
        rewalk.approachBand = null;
      }
      emission(lat, lon, acc, heading);
      return;
    }
    if (rewalk.phase === 'finished') { emission(lat, lon, acc, heading); return; }
  }
  if (rewalk.phase !== 'follow') return;

  const projection = nearestProjection(lat, lon, rewalk.pts, rewalk.cum, rewalk.segmentRanges, rewalk.idx);
  if (!projection) return;
  rewalk.idx = projection.idx;
  rewalk.maxIdx = Math.max(rewalk.maxIdx, projection.idx);
  rewalk.along = projection.along;
  rewalk.maxAlong = Math.max(rewalk.maxAlong, projection.along);
  rewalk.projection = projection;
  rewalk.offTrack = projection.dist;
  rewalk.routeBearing = routeBearingAt(projection, rewalk.pts, rewalk.cum, rewalk.segmentRanges);
  const offRouteAnnounce = updateOffRoute(projection.dist, fixT);
  const along = rewalk.along;
  updateTurn(along);

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
      const wpBearing = safeBearing(lat, lon, w.lat, w.lon);
      const eta = etaSecondsFor(d);
      speak(t(named ? 'rewalk.nearAnnounce' : 'rewalk.nearAnnounceSolo', {
        dist: distText(d),
        direction: wpBearing == null ? '' : t('rewalk.toward', { direction: t(`rewalk.directions.${directionKey(wpBearing)}`) }),
        type: label, name: w.name || label,
        eta: eta == null ? '' : t('rewalk.etaPhrase', { time: localizedEta(eta) })
      }));
    }
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
  emission(lat, lon, acc, heading, offRouteAnnounce);
}

export function getRewalkNavigation(platform: NavigationPlatform = 'web'): (NavigationLinks & { distanceM: number }) | null {
  const target = rewalk.navTarget;
  const from = rewalk.lastFix;
  if (!rewalk.active || rewalk.phase !== 'approach' || !target || !from) return null;
  const distanceM = haversine(from.lat, from.lon, target.lat, target.lon);
  const links = navigationLinks(target.lat, target.lon, distanceM, rewalk.name, platform);
  return links ? { ...links, distanceM } : null;
}

export function markExternalNavigation() {
  if (!rewalk.active || rewalk.phase !== 'approach' || !getRewalkNavigation()) return false;
  rewalk.externalNav = true;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  emit('rewalk:navigation', { active: true });
  return true;
}

export function stopRewalk() {
  rewalkRequest++;
  if (!rewalk.active) return;
  stopWatch();
  stopSim();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  rewalk.active = false;
  rewalk.finished = false;
  rewalk.navTarget = null;
  rewalk.navBearing = null;
  rewalk.routeBearing = null;
  rewalk.projection = null;
  rewalk.turn = null;
  rewalk.etaSeconds = null;
  rewalk.etaSource = null;
  rewalk.etaEstimated = false;
  rewalk.speedMps = null;
  rewalk.speedSource = null;
  rewalk.recentSpeedMps = null;
  rewalk.recentSpeedT = null;
  rewalk.offRoute = false;
  rewalk.offRouteForMs = 0;
  rewalk.offRouteSinceT = null;
  rewalk.lastOffFixT = null;
  rewalk.lastFixT = null;
  rewalk.lastTimedFix = null;
  rewalk.lastOffAnnounce = null;
  rewalk.externalNav = false;
  rewalk.approachBand = null;
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
