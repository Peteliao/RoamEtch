// IndexedDB runtime schema (Dexie). All coordinates stored here are WGS-84, SI units.
import Dexie, { type Transaction } from 'dexie';
import { uuid } from './geo';
import { DATABASE_MIGRATIONS, DATABASE_NAME, TRIP_SCHEMA_VERSION } from './migrations';

export { DATABASE_SCHEMA_VERSION, TRIP_SCHEMA_VERSION } from './migrations';

export const db = new Dexie(DATABASE_NAME) as Dexie & {
  trips: any; segments: any; trackChunks: any; trackSnapshots: any; waypoints: any; media: any; elevCache: any; shareImports: any;
};
for (const migration of DATABASE_MIGRATIONS) {
  const version = db.version(migration.version).stores(migration.stores);
  if (migration.upgrade) version.upgrade(migration.upgrade);
}
db.on?.('versionchange', () => db.close());

export const CHUNK_SIZE = 400;

export function abortTransactionOnSignal(transaction: Transaction, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const abort = () => {
    if (!transaction.active) return;
    try { transaction.abort(); } catch { /* A commit that already won cannot be rolled back. */ }
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return () => signal.removeEventListener('abort', abort);
}

// ---------- trips ----------
export async function createTrip({ id = uuid(), name, activity = 'hike', status = 'recording', createdAt = Date.now(), hasTime, publish = true }: any = {}) {
  const trip = {
    id, name: name || '', activity, status,
    schemaVersion: TRIP_SCHEMA_VERSION, createdAt, updatedAt: Date.now(),
    privacy: { radius: 300, hideSensitive: true },
    statsCache: null,
    ...(hasTime != null ? { hasTime } : {})
  };
  if (publish) await db.trips.add(trip);
  return trip;
}
export const getTrip = (id) => db.trips.get(id);
export const listTrips = () => db.trips.orderBy('updatedAt').reverse().toArray();
function nextTripRevision(current) {
  const previous = Number.isFinite(current?.updatedAt) ? current.updatedAt : 0;
  return Math.max(Date.now(), previous + 1);
}

export async function updateTripInTx(id, patch, { touch = true }: { touch?: boolean } = {}) {
  const current = touch || patch.activity != null ? await db.trips.get(id) : null;
  const activityChanged = patch.activity != null && current && current.activity !== patch.activity;
  await db.trips.update(id, {
    ...patch,
    ...(activityChanged ? { statsCache: null, reportedDistance: null } : {}),
    ...(touch ? { updatedAt: nextTripRevision(current) } : {})
  });
}

export async function updateTrip(id, patch, { touch = true }: { touch?: boolean } = {}) {
  // Allocate revisions atomically so same-millisecond edits get distinct tokens.
  if (touch || patch.activity != null) await db.transaction('rw', db.trips, () => updateTripInTx(id, patch, { touch }));
  else await updateTripInTx(id, patch, { touch });
}
export async function cacheTripStats(id, expectedUpdatedAt, statsCache) {
  return db.transaction('rw', db.trips, async () => {
    const trip = await db.trips.get(id);
    if (!trip || trip.updatedAt !== expectedUpdatedAt) return false;
    await db.trips.update(id, { statsCache });
    return true;
  });
}

export async function deleteTrip(id) {
  await db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.trackSnapshots, db.waypoints, db.media, db.shareImports], async () => {
    await db.trackChunks.where('tripId').equals(id).delete();
    await db.trackSnapshots.where('tripId').equals(id).delete();
    await db.segments.where('tripId').equals(id).delete();
    await db.waypoints.where('tripId').equals(id).delete();
    await db.media.where('tripId').equals(id).delete();
    await db.shareImports.where('tripId').equals(id).delete();
    await db.trips.delete(id);
  });
}

// ---------- shared-link imports ----------
export const getShareImport = (fingerprint: string) => db.shareImports.get(fingerprint);
export async function rememberShareImport(fingerprint: string, tripId: string) {
  await db.shareImports.put({ fingerprint, tripId, createdAt: Date.now() });
}
export async function forgetShareImport(fingerprint: string) {
  await db.shareImports.delete(fingerprint);
}

// ---------- segments & chunks ----------
export async function addSegment(tripId, startTime = Date.now()) {
  const count = await db.segments.where('tripId').equals(tripId).count();
  const seg = { id: uuid(), tripId, index: count, startTime, endTime: null };
  await db.segments.add(seg);
  return seg;
}
export const listSegments = (tripId) => db.segments.where('tripId').equals(tripId).sortBy('index');

function segmentChunkRange(segmentId) {
  return db.trackChunks.where('[segmentId+seq]')
    .between([segmentId, 0], [segmentId, Number.MAX_SAFE_INTEGER]);
}

function isValidTrackPoint(point) {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

export async function appendPoints(segmentId, tripId, points, { allowUnpublished = false }: { allowUnpublished?: boolean } = {}) {
  if (!points.length) return;
  await db.transaction('rw', [db.trackChunks, db.segments, ...(allowUnpublished ? [] : [db.trips])], async () => {
    const last = await segmentChunkRange(segmentId).last();
    if (last && last.points.length + points.length <= CHUNK_SIZE) {
      last.points.push(...points);
      await db.trackChunks.put(last);
    } else {
      const seq = last ? last.seq + 1 : 0;
      // split oversized batches across chunks
      for (let i = 0; i < points.length; i += CHUNK_SIZE) {
        await db.trackChunks.add({
          id: uuid(), tripId, segmentId, seq: seq + Math.floor(i / CHUNK_SIZE),
          points: points.slice(i, i + CHUNK_SIZE)
        });
      }
    }
    await db.segments.update(segmentId, { endTime: points[points.length - 1].t });
    if (allowUnpublished) return;
    const trip = await db.trips.get(tripId);
    await updateTrip(tripId, {
      ...(trip?.reportedDistance != null ? { reportedDistance: null } : {})
    });
  });
}

export async function loadTripTrack(tripId) {
  const [trip, segments] = await Promise.all([db.trips.get(tripId), listSegments(tripId)]);
  if (!trip) return null;
  const chunks = await db.trackChunks.where('tripId').equals(tripId).toArray();
  const bySeg = new Map();
  for (const c of chunks) {
    if (!bySeg.has(c.segmentId)) bySeg.set(c.segmentId, []);
    bySeg.get(c.segmentId).push(c);
  }
  const segData = segments.map((s) => {
    const cs = (bySeg.get(s.id) || []).sort((a, b) => a.seq - b.seq);
    return { ...s, points: cs.flatMap((c) => c.points) };
  });
  return { trip, segments: segData };
}

export async function loadTripFull(tripId) {
  const [track, waypoints, media] = await Promise.all([
    loadTripTrack(tripId),
    db.waypoints.where('tripId').equals(tripId).toArray(),
    db.media.where('tripId').equals(tripId).toArray()
  ]);
  return track ? { ...track, waypoints, media } : null;
}

export async function loadFirstTrackPoint(tripId) {
  const segments = await listSegments(tripId);
  for (const segment of segments) {
    let first = null;
    await segmentChunkRange(segment.id).each((chunk) => {
      const point = chunk.points?.find(isValidTrackPoint);
      if (!point) return;
      first = { lat: point.lat, lon: point.lon };
      return false;
    });
    if (first) return first;
  }
  return null;
}

export async function loadLastTrackTimestamp(segmentId) {
  let latest = null;
  await segmentChunkRange(segmentId).reverse().each((chunk) => {
    let chunkLatest = null;
    for (const point of chunk.points || []) {
      if (Number.isFinite(point?.t) && (chunkLatest == null || point.t > chunkLatest)) chunkLatest = point.t;
    }
    if (chunkLatest == null) return;
    latest = chunkLatest;
    return false;
  });
  return latest;
}

export async function loadTripPreview(tripId) {
  const [trip, segments, waypoints] = await Promise.all([
    db.trips.get(tripId),
    listSegments(tripId),
    db.waypoints.where('tripId').equals(tripId).toArray()
  ]);
  if (!trip) return null;

  const counts = await Promise.all(segments.map((segment) => segmentChunkRange(segment.id).count()));
  const totalChunks = counts.reduce((sum, count) => sum + count, 0);
  const selectedOrdinals = new Set<number>();
  const selectedChunkCount = Math.min(16, totalChunks);
  for (let i = 0; i < selectedChunkCount; i++) {
    selectedOrdinals.add(selectedChunkCount === 1
      ? 0
      : Math.round(i * (totalChunks - 1) / (selectedChunkCount - 1)));
  }

  const selectedChunks = [];
  const ordinals = [...selectedOrdinals].sort((a, b) => a - b);
  let ordinal = 0;
  let selectedIndex = 0;
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    for (let localOffset = 0; localOffset < counts[segmentIndex]; localOffset++) {
      if (ordinals[selectedIndex] === ordinal) {
        const [chunk] = await segmentChunkRange(segment.id).offset(localOffset).limit(1).toArray();
        if (chunk) selectedChunks.push({
          segmentId: segment.id,
          points: (chunk.points || []).filter(isValidTrackPoint)
        });
        selectedIndex++;
      }
      ordinal++;
    }
  }

  const flattened = selectedChunks.flatMap((chunk) => chunk.points.map((point) => ({ segmentId: chunk.segmentId, point })));
  let sampled = flattened;
  if (flattened.length > 500) {
    sampled = [flattened[0]];
    for (let i = 1; i < 499; i++) sampled.push(flattened[Math.round(i * (flattened.length - 1) / 499)]);
    sampled.push(flattened[flattened.length - 1]);
  }
  const pointsBySegment = new Map<string, any[]>(segments.map((segment) => [segment.id, []]));
  for (const { segmentId, point } of sampled) pointsBySegment.get(segmentId).push(point);

  return {
    trip,
    segments: segments.map((segment) => ({ ...segment, points: pointsBySegment.get(segment.id) })),
    waypoints,
    readOnly: true
  };
}

export async function replaceSegmentPointsInTx(segmentId, tripId, points) {
  await db.trackChunks.where('segmentId').equals(segmentId).delete();
  if (points.length) {
    for (let i = 0; i < points.length; i += CHUNK_SIZE) {
      await db.trackChunks.add({
        id: uuid(), tripId, segmentId, seq: Math.floor(i / CHUNK_SIZE),
        points: points.slice(i, i + CHUNK_SIZE)
      });
    }
  }
  await db.segments.update(segmentId, {
    startTime: points[0]?.t ?? null, endTime: points[points.length - 1]?.t ?? null
  });
}

/** Replace all points of a segment (used by editor). */
export async function replaceSegmentPoints(segmentId, tripId, points) {
  await db.transaction('rw', [db.trackChunks, db.segments, db.trips], async () => {
    await replaceSegmentPointsInTx(segmentId, tripId, points);
    const trip = await db.trips.get(tripId);
    await updateTripInTx(tripId, {
      statsCache: null, thumbPoints: null,
      ...(trip?.reportedDistance != null ? { reportedDistance: null } : {})
    });
  });
}

export async function saveTrackSnapshotInTx(tripId, segments) {
  if (await db.trackSnapshots.where('tripId').equals(tripId).count()) return false;
  const createdAt = Date.now();
  for (const segment of segments) {
    const points = segment.points || [];
    for (let i = 0; i < points.length; i += CHUNK_SIZE) {
      await db.trackSnapshots.add({
        id: uuid(), tripId, segmentId: segment.id, segmentIndex: segment.index,
        seq: Math.floor(i / CHUNK_SIZE), createdAt,
        points: points.slice(i, i + CHUNK_SIZE).map((point) => ({ ...point }))
      });
    }
  }
  await db.trips.update(tripId, { gpsCleanedAt: createdAt, statsCache: null, thumbPoints: null });
  return true;
}

export async function saveTrackSnapshot(tripId, segments) {
  return db.transaction('rw', [db.trackSnapshots, db.trips], () => saveTrackSnapshotInTx(tripId, segments));
}

function invalidTrackSnapshot() {
  throw new Error('invalid-snapshot');
}

export async function loadTrackSnapshot(tripId) {
  const [chunks, segments] = await Promise.all([
    db.trackSnapshots.where('tripId').equals(tripId).toArray(),
    db.segments.where('tripId').equals(tripId).toArray()
  ]);
  const segmentById = new Map<string, any>(segments.map((segment) => [segment.id, segment]));
  const segmentSeqs = new Map();
  const sequenceKeys = new Set();
  const rowIds = new Set();
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object' || typeof chunk.id !== 'string'
      || chunk.tripId !== tripId || typeof chunk.segmentId !== 'string'
      || rowIds.has(chunk.id) || !Number.isFinite(chunk.createdAt)
      || !Number.isInteger(chunk.seq) || chunk.seq < 0
      || !Number.isInteger(chunk.segmentIndex) || chunk.segmentIndex < 0
      || !Array.isArray(chunk.points)) invalidTrackSnapshot();
    const segment = segmentById.get(chunk.segmentId);
    if (!segment || segment.index !== chunk.segmentIndex) invalidTrackSnapshot();
    const sequenceKey = `${chunk.segmentId}:${chunk.seq}`;
    if (sequenceKeys.has(sequenceKey)) invalidTrackSnapshot();
    for (const point of chunk.points) {
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)
        || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180
        || (point.t != null && !Number.isFinite(point.t))) invalidTrackSnapshot();
    }
    rowIds.add(chunk.id);
    sequenceKeys.add(sequenceKey);
    if (!segmentSeqs.has(chunk.segmentId)) segmentSeqs.set(chunk.segmentId, []);
    segmentSeqs.get(chunk.segmentId).push(chunk.seq);
  }
  for (const seqs of segmentSeqs.values()) {
    seqs.sort((a, b) => a - b);
    if (seqs.some((seq, index) => seq !== index)) invalidTrackSnapshot();
  }
  chunks.sort((a, b) => a.segmentIndex - b.segmentIndex || a.seq - b.seq);
  const bySegment = new Map();
  for (const chunk of chunks) {
    if (!bySegment.has(chunk.segmentId)) bySegment.set(chunk.segmentId, []);
    bySegment.get(chunk.segmentId).push(chunk);
  }
  return [...bySegment.values()].map((rows) => ({
    id: rows[0].segmentId,
    index: rows[0].segmentIndex,
    points: rows.flatMap((row) => row.points),
    createdAt: rows[0].createdAt
  }));
}

export async function getTrackSnapshotSummary(tripId) {
  const segmentIds = new Set();
  let pointCount = 0;
  let createdAt = Infinity;
  let found = false;
  await db.trackSnapshots.where('tripId').equals(tripId).each((chunk) => {
    found = true;
    segmentIds.add(chunk.segmentId);
    pointCount += chunk.points?.length || 0;
    createdAt = Math.min(createdAt, chunk.createdAt);
  });
  return found ? { segments: segmentIds.size, points: pointCount, createdAt } : null;
}

export async function restoreTrackSnapshot(tripId) {
  return db.transaction('rw', [db.trackChunks, db.trackSnapshots, db.segments, db.trips], async () => {
    const snapshot = await loadTrackSnapshot(tripId);
    const current = await db.segments.where('tripId').equals(tripId).toArray();
    const currentIds = new Set(current.map((segment) => segment.id));
    let restored = 0;
    for (const segment of snapshot) {
      if (!currentIds.has(segment.id)) continue;
      await replaceSegmentPointsInTx(segment.id, tripId, segment.points.map((point) => ({ ...point })));
      restored += segment.points.length;
    }
    if (restored) await updateTripInTx(tripId, {
      gpsRestoredAt: Date.now(), statsCache: null, thumbPoints: null, reportedDistance: null
    });
    return restored;
  });
}

export async function pruneEmptySegments(tripId) {
  return db.transaction('rw', [db.trackChunks, db.segments], async () => {
    const segments = await listSegments(tripId);
    const emptyIds = [];
    for (const seg of segments) {
      const chunkCount = await db.trackChunks.where('segmentId').equals(seg.id).count();
      if (!chunkCount) emptyIds.push(seg.id);
    }
    for (const id of emptyIds) {
      await db.trackChunks.where('segmentId').equals(id).delete();
      await db.segments.delete(id);
    }
    return emptyIds.length;
  });
}

export async function deleteSegment(segmentId) {
  await db.trackChunks.where('segmentId').equals(segmentId).delete();
  await db.segments.delete(segmentId);
}

// ---------- waypoints ----------
export async function addWaypoint(wp) {
  const full = { id: uuid(), hidden: false, mediaIds: [], time: Date.now(), ...wp };
  await db.waypoints.add(full);
  return full;
}
export const updateWaypoint = (id, patch) => db.waypoints.update(id, patch);
export const deleteWaypoint = (id) => db.waypoints.delete(id);
export const getWaypoint = (id) => db.waypoints.get(id);
export const listWaypoints = (tripId) => db.waypoints.where('tripId').equals(tripId).toArray();

export async function addPhotoWaypoint({ tripId, photo, fix, takenAt, nameFor = () => '' }: any) {
  return db.transaction('rw', [db.media, db.waypoints, db.trips], async () => {
    const photos = await db.waypoints.where('tripId').equals(tripId).filter((w) => w.type === 'photo').toArray();
    const n = photos.length + 1;
    const media = {
      id: uuid(), tripId, blob: photo.blob, thumb: photo.thumb,
      width: photo.width, height: photo.height, createdAt: Date.now()
    };
    const waypoint = {
      id: uuid(), tripId, lat: fix.lat, lon: fix.lon,
      alt: fix.alt ?? null, acc: fix.acc ?? null,
      type: 'photo', name: nameFor(n), time: takenAt,
      mediaIds: [media.id], hidden: false
    };
    await db.media.add(media);
    await db.waypoints.add(waypoint);
    await updateTrip(tripId, {});
    return { media, waypoint, number: n };
  });
}

export async function deletePhotoWaypoint(waypointId, tripId, mediaId) {
  return db.transaction('rw', [db.media, db.waypoints, db.trips], async () => {
    await db.waypoints.delete(waypointId);
    const references = mediaId
      ? await db.waypoints.where('tripId').equals(tripId).filter((w) => w.mediaIds?.includes(mediaId)).toArray()
      : [];
    if (mediaId && !references.length) await db.media.delete(mediaId);
    await updateTrip(tripId, {});
  });
}

export async function saveWaypointWithMedia({ waypoint, tripId, photos, removedMediaIds, isNew }) {
  return db.transaction('rw', [db.media, db.waypoints], async () => {
    const next = { ...waypoint, mediaIds: [...(waypoint.mediaIds || [])] };
    for (const photo of photos) {
      const media = await addMedia({ tripId, blob: photo.blob, thumb: photo.thumb, width: photo.width, height: photo.height });
      next.mediaIds.push(media.id);
    }
    for (const mediaId of removedMediaIds) {
      if (next.mediaIds.includes(mediaId)) continue;
      const references = await db.waypoints.filter((item) => item.id !== waypoint.id && item.mediaIds?.includes(mediaId)).count();
      if (!references) await db.media.delete(mediaId);
    }
    if (isNew) return addWaypoint({ ...next, tripId });
    const updated = await updateWaypoint(waypoint.id, next);
    if (!updated) throw new Error('Waypoint no longer exists');
    return next;
  });
}

// ---------- media ----------
export async function addMedia({ tripId, blob, thumb, width, height }) {
  const m = { id: uuid(), tripId, blob, thumb, width, height, createdAt: Date.now() };
  await db.media.add(m);
  return m;
}
export const getMedia = (id) => db.media.get(id);
export const deleteMedia = (id) => db.media.delete(id);

// ---------- elevation grid cache ----------
export const gridKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;
export async function elevCacheGet(lat, lon) {
  const row = await db.elevCache.get(gridKey(lat, lon));
  return row ? row.elevation : null;
}
export async function elevCachePut(lat, lon, elevation) {
  await db.elevCache.put({ key: gridKey(lat, lon), elevation, fetchedAt: Date.now() });
}

// ---------- maintenance ----------
export async function storageEstimate() {
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : { usage: 0, quota: 0 };
  let persisted = null;
  try { persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { persisted = null; }
  return { ...estimate, persisted };
}

export async function requestStoragePersistence() {
  if (!navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

export async function eraseAll() {
  await Promise.all([
    db.trips.clear(), db.segments.clear(), db.trackChunks.clear(), db.trackSnapshots.clear(),
    db.waypoints.clear(), db.media.clear(), db.elevCache.clear(), db.shareImports.clear()
  ]);
}

/** Integrity check: isolate chunks referencing missing segments/trips. */
export async function isolateDamaged() {
  return db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.trackSnapshots], async () => {
    const trips = new Set((await db.trips.toArray()).map((t) => t.id));
    const segs = new Map((await db.segments.toArray()).map((s) => [s.id, s.tripId]));
    const badSegs = [];
    await db.segments.each((s) => { if (!trips.has(s.tripId)) badSegs.push(s.id); });
    const removedSegments = new Set(badSegs);
    const badChunks = [];
    await db.trackChunks.each((c) => {
      if (!trips.has(c.tripId) || segs.get(c.segmentId) !== c.tripId || !Array.isArray(c.points)) badChunks.push(c.id);
    });
    const badSnapshots = [];
    await db.trackSnapshots.each((snapshot) => {
      if (!trips.has(snapshot.tripId) || !segs.has(snapshot.segmentId) || removedSegments.has(snapshot.segmentId)
        || segs.get(snapshot.segmentId) !== snapshot.tripId || !Array.isArray(snapshot.points)) badSnapshots.push(snapshot.id);
    });
    if (badChunks.length) await db.trackChunks.bulkDelete(badChunks);
    if (badSegs.length) await db.segments.bulkDelete(badSegs);
    if (badSnapshots.length) await db.trackSnapshots.bulkDelete(badSnapshots);
    return badChunks.length + badSegs.length + badSnapshots.length;
  });
}