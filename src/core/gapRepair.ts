// One-click repair for track gaps (usually accidental lock-screen suspensions):
// routes each segment break over OSM roads, then stitches interpolated points
// into the segment before the break. Network failures leave the gap untouched.
import { haversine, simplify } from './geo';
import { db, loadTripTrack, replaceSegmentPointsInTx, updateTripInTx, abortTransactionOnSignal } from './store';
import { pushAction } from './history';
import { emit } from './events';
import { applyPrivacy } from './privacy';

const MIN_GAP = 60;
const ROUTE_TIMEOUT = 9000;
const MIN_ROUTE_POINTS = 2;

export type TrackGap = {
  index: number;
  from: any;
  to: any;
  distance: number;
  dt: number | null;
  segFrom: string;
  segTo: string;
};

export function findTrackGaps(segments: any[], { minDist = MIN_GAP }: { minDist?: number } = {}): TrackGap[] {
  const gaps: TrackGap[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i]?.points?.at(-1);
    const b = segments[i + 1]?.points?.[0];
    if (!a || !b) continue;
    const distance = haversine(a.lat, a.lon, b.lat, b.lon);
    if (distance < minDist) continue;
    gaps.push({
      index: i, from: a, to: b, distance,
      dt: a.t && b.t ? b.t - a.t : null,
      segFrom: segments[i].id, segTo: segments[i + 1].id
    });
  }
  return gaps;
}

function profilesFor(activity: string) {
  if (activity === 'bike') return ['trekking'];
  if (activity === 'drive' || activity === 'travel') return ['car-eco'];
  return ['hiking-beta'];
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason?.name === 'AbortError'
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
}

async function fetchJson(url: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUTE_TIMEOUT);
  const relay = () => ctrl.abort();
  signal?.addEventListener('abort', relay, { once: true });
  if (signal?.aborted) ctrl.abort();
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/geo+json, application/json' } });
    throwIfAborted(signal);
    if (!res.ok) return null;
    const data = await res.json();
    throwIfAborted(signal);
    return data;
  } catch {
    throwIfAborted(signal);
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relay);
  }
}

export async function routeOverRoads(from: any, to: any, activity: string, signal?: AbortSignal) {
  throwIfAborted(signal);
  const lonlats = `${from.lon},${from.lat}|${to.lon},${to.lat}`;
  for (const profile of profilesFor(activity)) {
    throwIfAborted(signal);
    const j = await fetchJson(`https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`, signal);
    const coords = j?.features?.[0]?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= MIN_ROUTE_POINTS) {
      return { coords: coords.map((c: any[]) => [Number(c[0]), Number(c[1])]), provider: `BRouter ${profile}` };
    }
  }
  throwIfAborted(signal);
  const osrmProfile = activity === 'bike' ? 'bike' : activity === 'drive' || activity === 'travel' ? 'driving' : 'foot';
  const j = await fetchJson(
    `https://router.project-osrm.org/route/v1/${osrmProfile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson&steps=false`,
    signal
  );
  const coords = j?.routes?.[0]?.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= MIN_ROUTE_POINTS) {
    return { coords: coords.map((c: any[]) => [Number(c[0]), Number(c[1])]), provider: 'OSRM' };
  }
  return null;
}

/** Build monotonic synthetic points from A → routed geometry → B. */
export function buildGapPoints(from: any, to: any, coords: number[][]) {
  const raw = [
    { lat: from.lat, lon: from.lon },
    ...coords.map(([lon, lat]) => ({ lat, lon })),
    { lat: to.lat, lon: to.lon }
  ].filter((p) => isFinite(p.lat) && isFinite(p.lon));

  const dedup = [];
  for (const p of raw) {
    const prev = dedup[dedup.length - 1];
    if (!prev || haversine(prev.lat, prev.lon, p.lat, p.lon) > 1.5) dedup.push(p);
    else dedup[dedup.length - 1] = p;
  }
  if (dedup.length < 2) return null;
  const thinned = simplify(dedup, 5);
  if (thinned.length < 2) return null;

  const cum = [0];
  for (let i = 1; i < thinned.length; i++) {
    cum.push(cum[i - 1] + haversine(thinned[i - 1].lat, thinned[i - 1].lon, thinned[i].lat, thinned[i].lon));
  }
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  const t0 = Number(from.t) || Date.now() - 60_000;
  let t1 = Number(to.t);
  if (!isFinite(t1) || t1 <= t0) t1 = t0 + Math.max(60_000, Math.round((total / 1.2) * 1000));

  let prevT = t0 - 1;
  const pts = thinned.map((p, i) => {
    const last = i === thinned.length - 1;
    const ideal = t0 + Math.round((t1 - t0) * (cum[i] / total));
    const t = last ? t1 : Math.max(prevT + 1, Math.min(t1 - 1, ideal));
    prevT = t;
    return { ...p, t, alt: null, altSrc: null, acc: null, speed: null, synth: true };
  });
  return { points: pts, distance: total };
}

export async function bridgeTrackGapsForExport(full: any, cropped: any, privacy: any = {}, {
  signal
}: { signal?: AbortSignal } = {}) {
  const originalPoints = full.segments.flatMap((seg) => seg.points);
  if (originalPoints.length < 2 || cropped.segments.length < 2) {
    return { ...cropped, bridged: 0, failed: 0, points: 0 };
  }
  const boundaries = [];
  for (let i = 0; i < full.segments.length - 1; i++) {
    const from = full.segments[i]?.points?.at(-1);
    const to = full.segments[i + 1]?.points?.[0];
    if (from && to) boundaries.push({ from, to });
  }
  const segments = cropped.segments.map((seg) => ({ ...seg, points: [...seg.points] }));
  const gaps = findTrackGaps(segments).filter((gap) =>
    boundaries.some(({ from, to }) => gap.from === from && gap.to === to)
  );
  let bridged = 0, failed = 0, points = 0;
  for (const gap of gaps) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const route = await routeOverRoads(gap.from, gap.to, full.trip?.activity || 'hike', signal);
    const built = route ? buildGapPoints(gap.from, gap.to, route.coords as number[][]) : null;
    if (!built || !segments[gap.index]) { failed++; continue; }
    segments[gap.index].points.push(...built.points.slice(1));
    bridged++;
    points += built.points.length - 1;
  }
  if (!bridged) return { ...cropped, bridged, failed, points };
  const sanitized = applyPrivacy({ ...full, segments }, {
    ...privacy,
    start: originalPoints[0],
    end: originalPoints[originalPoints.length - 1]
  });
  return { ...sanitized, bridged, failed, points };
}

export async function repairTrackGaps(tripId: string, {
  signal, onProgress
}: { signal?: AbortSignal; onProgress?: (p: { done: number; total: number; added: number }) => void } = {}) {
  const full = await loadTripTrack(tripId);
  if (!full) return { repaired: 0, failed: 0, points: 0, distance: 0 };
  const expectedUpdatedAt = full.trip.updatedAt;
  const gaps = findTrackGaps(full.segments);
  const edits: { segmentId: string; before: any[]; after: any[] }[] = [];
  let failed = 0, added = 0, distance = 0;

  for (let gi = 0; gi < gaps.length; gi++) {
    throwIfAborted(signal);
    const gap = gaps[gi];
    const route = await routeOverRoads(gap.from, gap.to, full.trip.activity || 'hike', signal);
    if (!route) {
      failed++;
      onProgress?.({ done: gi + 1, total: gaps.length, added });
      throwIfAborted(signal);
      continue;
    }
    const built = buildGapPoints(gap.from, gap.to, route.coords as number[][]);
    if (!built) {
      failed++;
      onProgress?.({ done: gi + 1, total: gaps.length, added });
      throwIfAborted(signal);
      continue;
    }
    const seg = full.segments[gap.index];
    if (!seg) { failed++; continue; }
    const before = seg.points.map((p: any) => ({ ...p }));
    const after = [...before, ...built.points.slice(1)];
    edits.push({ segmentId: seg.id, before, after });
    added += built.points.length - 1;
    distance += built.distance;
    onProgress?.({ done: gi + 1, total: gaps.length, added });
    throwIfAborted(signal);
    if (gi < gaps.length - 1) {
      await new Promise((r) => setTimeout(r, 180));
      throwIfAborted(signal);
    }
  }

  throwIfAborted(signal);
  if (!edits.length) return { repaired: 0, failed, points: 0, distance: 0 };

  const write = async (
    useAfter: boolean,
    guard: { segments: any[]; expectedUpdatedAt?: number; allowAdditional: boolean },
    operationSignal?: AbortSignal
  ) => {
    throwIfAborted(operationSignal);
    let detachAbort: (() => void) | undefined;
    try {
      await db.transaction('rw', [db.trackChunks, db.segments, db.trips], async (transaction) => {
        detachAbort = abortTransactionOnSignal(transaction, operationSignal);
        throwIfAborted(operationSignal);
        const trip = await db.trips.get(tripId);
        throwIfAborted(operationSignal);
        if (!trip || (guard.expectedUpdatedAt != null && trip.updatedAt !== guard.expectedUpdatedAt)) throw new Error('track-changed');
        const current = await loadTripTrack(tripId);
        throwIfAborted(operationSignal);
        if (!trackMatches(current, guard.segments, guard.allowAdditional)) throw new Error('track-changed');
        for (const edit of edits) {
          throwIfAborted(operationSignal);
          await replaceSegmentPointsInTx(edit.segmentId, tripId, useAfter ? edit.after : edit.before);
        }
        throwIfAborted(operationSignal);
        await updateTripInTx(tripId, { statsCache: null, thumbPoints: null, reportedDistance: null });
        throwIfAborted(operationSignal);
      });
    } finally {
      detachAbort?.();
    }
  };

  await write(true, { segments: full.segments, expectedUpdatedAt, allowAdditional: false }, signal);
  pushAction({
    label: 'gap-repair',
    undo: async () => {
      await write(false, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.after })), allowAdditional: true });
      emit('gap:changed', { tripId });
    },
    redo: async () => {
      await write(true, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.before })), allowAdditional: true });
      emit('gap:changed', { tripId });
    }
  });

  return { repaired: edits.length, failed, points: added, distance };
}

function trackMatches(current, expectedSegments, allowAdditional) {
  if (!current || !Array.isArray(current.segments)) return false;
  if (!allowAdditional && current.segments.length !== expectedSegments.length) return false;
  const byId = new Map(current.segments.map((segment) => [segment.id, segment]));
  return expectedSegments.every((segment, index) => {
    const actual = allowAdditional ? byId.get(segment.id) : current.segments[index];
    return actual?.id === segment.id && samePoints(actual.points, segment.points);
  });
}

function samePoints(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i], right = b[i];
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key]))) return false;
  }
  return true;
}
