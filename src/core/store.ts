// IndexedDB runtime schema (Dexie). All coordinates stored here are WGS-84, SI units.
import Dexie, { type Transaction } from 'dexie';
import { uuid } from './geo';
import { DATABASE_MIGRATIONS, DATABASE_NAME, TRIP_SCHEMA_VERSION } from './migrations';
import { installDatabaseWriteGuard } from './locks';

export { DATABASE_SCHEMA_VERSION, TRIP_SCHEMA_VERSION } from './migrations';

export const db = new Dexie(DATABASE_NAME) as Dexie & {
  trips: any; segments: any; trackChunks: any; trackSnapshots: any; waypoints: any; media: any; elevCache: any; shareImports: any; quarantine: any;
};
for (const migration of DATABASE_MIGRATIONS) {
  const version = db.version(migration.version).stores(migration.stores);
  if (migration.upgrade) version.upgrade(migration.upgrade);
}
db.on?.('versionchange', () => db.close());
installDatabaseWriteGuard(db, () => !!Dexie.currentTransaction);

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
  await db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.trackSnapshots, db.waypoints, db.media, db.shareImports, db.quarantine], async () => {
    await db.trackChunks.where('tripId').equals(id).delete();
    await db.trackSnapshots.where('tripId').equals(id).delete();
    await db.segments.where('tripId').equals(id).delete();
    await db.waypoints.where('tripId').equals(id).delete();
    await db.media.where('tripId').equals(id).delete();
    await db.shareImports.where('tripId').equals(id).delete();
    await db.quarantine.where('tripId').equals(id).delete();
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

export async function loadTripTrack(tripId, knownTrip = null, { cooperative = true }: { cooperative?: boolean } = {}) {
  const trip = knownTrip || await db.trips.get(tripId);
  if (!trip) return null;
  const segments = await listSegments(tripId);
  const segData = await Promise.all(segments.map(async (segment) => {
    const points = [];
    const batchSize = 8;
    for (let offset = 0; ; offset += batchSize) {
      const chunks = await segmentChunkRange(segment.id).offset(offset).limit(batchSize).toArray();
      for (const chunk of chunks) {
        for (const point of chunk.points || []) points.push(point);
      }
      if (chunks.length < batchSize) break;
      if (!cooperative) continue;
      // Bound IndexedDB delivery and array growth so million-point reads stay cooperative.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { ...segment, points };
  }));
  return { trip, segments: segData };
}

export async function loadTripFull(tripId, { trackSnapshot = null, trackUnchanged = false }: { trackSnapshot?: any; trackUnchanged?: boolean } = {}) {
  const [trip, waypoints, media] = await Promise.all([
    db.trips.get(tripId),
    db.waypoints.where('tripId').equals(tripId).toArray(),
    db.media.where('tripId').equals(tripId).toArray()
  ]);
  if (!trip) return null;
  const metadataOnlyTrackReusable = trackUnchanged
    && trip.status !== 'recording' && trip.status !== 'paused';
  const reuseTrack = trackSnapshot?.trip.id === tripId
    && (metadataOnlyTrackReusable || (trackSnapshot.trip.updatedAt || 0) === (trip.updatedAt || 0))
    && Array.isArray(trackSnapshot.segments);
  const track = reuseTrack
    ? { trip, segments: trackSnapshot.segments }
    : await loadTripTrack(tripId, trip);
  return { ...track, waypoints, media };
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
  const segment = await db.segments.get(segmentId);
  if (!segment || segment.tripId !== tripId) throw new Error('segment-trip-mismatch');
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

function sameTrackPoints(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i], right = b[i];
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
      if (!Object.is(left, right)) return false;
      continue;
    }
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length
      || leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key]))) return false;
  }
  return true;
}

async function loadSegmentPoints(segmentId) {
  const points = [];
  await segmentChunkRange(segmentId).each((chunk) => {
    for (const point of chunk.points || []) points.push(point);
  });
  return points;
}

/** Replace all points of a segment only if its current contents still match the edit base. */
export async function replaceSegmentPoints(segmentId, tripId, points, expectedPoints) {
  await db.transaction('rw', [db.trackChunks, db.segments, db.trips], async () => {
    const segment = await db.segments.get(segmentId);
    if (!segment || segment.tripId !== tripId) throw new Error('segment-trip-mismatch');
    if (!sameTrackPoints(await loadSegmentPoints(segmentId), expectedPoints)) throw new Error('track-changed');
    await replaceSegmentPointsInTx(segmentId, tripId, points);
    const trip = await db.trips.get(tripId);
    await updateTripInTx(tripId, {
      statsCache: null, thumbPoints: null,
      ...(trip?.reportedDistance != null ? { reportedDistance: null } : {})
    });
  });
}

export async function saveTrackSnapshotInTx(tripId, segments) {
  if (await db.trackSnapshots.where('tripId').equals(tripId).filter((chunk) => !chunk.snapshotId).count()) return false;
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
    db.trackSnapshots.where('tripId').equals(tripId).filter((chunk) => !chunk.snapshotId).toArray(),
    db.segments.where('tripId').equals(tripId).toArray()
  ]);
  return decodeTrackSnapshot(tripId, chunks, segments);
}

function decodeTrackSnapshot(tripId, chunks, segments) {
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
    if (chunk.snapshotId) return;
    found = true;
    segmentIds.add(chunk.segmentId);
    pointCount += chunk.points?.length || 0;
    createdAt = Math.min(createdAt, chunk.createdAt);
  });
  return found ? { segments: segmentIds.size, points: pointCount, createdAt } : null;
}

export interface TrackRepairVersionSummary {
  versionId: string;
  version: number;
  createdAt: number;
  sourceUpdatedAt: number;
  sourceFingerprint: string;
  previewId: string;
  selectedCategories: string[];
  summary: Record<string, any>;
  metrics: Record<string, any>;
  semantics: Record<string, string>;
  segments: number;
  points: number;
}

function validateRepairMetadata(row, tripId) {
  if (!row || row.tripId !== tripId || row.kind !== 'repair' || typeof row.snapshotId !== 'string'
    || !row.snapshotId || !Number.isSafeInteger(row.repairVersion) || row.repairVersion < 1
    || !Number.isFinite(row.createdAt) || !Number.isFinite(row.sourceUpdatedAt)
    || typeof row.previewId !== 'string' || !row.previewId
    || typeof row.sourceFingerprint !== 'string' || !row.sourceFingerprint
    || !Array.isArray(row.selectedCategories) || row.selectedCategories.some((category) => typeof category !== 'string')
    || !row.summary || typeof row.summary !== 'object' || !row.metrics || typeof row.metrics !== 'object'
    || !row.semantics || typeof row.semantics !== 'object') throw new Error('invalid-track-repair-version');
}

function groupRepairVersions(tripId, rows) {
  const groups = new Map();
  for (const row of rows) {
    validateRepairMetadata(row, tripId);
    let group = groups.get(row.snapshotId);
    if (!group) groups.set(row.snapshotId, group = []);
    group.push(row);
  }
  return groups;
}

function repairVersionSummary(versionId, rows) {
  const first = rows[0];
  for (const row of rows) {
    if (row.repairVersion !== first.repairVersion || row.createdAt !== first.createdAt
      || row.sourceUpdatedAt !== first.sourceUpdatedAt || row.previewId !== first.previewId
      || row.sourceFingerprint !== first.sourceFingerprint
      || JSON.stringify(row.selectedCategories) !== JSON.stringify(first.selectedCategories)
      || JSON.stringify(row.summary) !== JSON.stringify(first.summary)
      || JSON.stringify(row.metrics) !== JSON.stringify(first.metrics)
      || JSON.stringify(row.semantics) !== JSON.stringify(first.semantics)) {
      throw new Error('inconsistent-track-repair-version');
    }
  }
  return {
    versionId,
    version: first.repairVersion,
    createdAt: first.createdAt,
    sourceUpdatedAt: first.sourceUpdatedAt,
    sourceFingerprint: first.sourceFingerprint,
    previewId: first.previewId,
    selectedCategories: [...first.selectedCategories],
    summary: first.summary,
    metrics: first.metrics,
    semantics: first.semantics,
    segments: new Set(rows.map((row) => row.segmentId)).size,
    points: rows.reduce((sum, row) => sum + row.points.length, 0)
  };
}

export async function saveTrackRepairVersionInTx(tripId, segments, metadata) {
  if (!Array.isArray(segments) || !segments.length || !metadata
    || !Number.isFinite(metadata.sourceUpdatedAt) || typeof metadata.sourceFingerprint !== 'string'
    || !metadata.sourceFingerprint || typeof metadata.previewId !== 'string' || !metadata.previewId
    || !Array.isArray(metadata.selectedCategories) || metadata.selectedCategories.some((category) => typeof category !== 'string')
    || !metadata.summary || typeof metadata.summary !== 'object' || !metadata.metrics || typeof metadata.metrics !== 'object'
    || !metadata.semantics || typeof metadata.semantics !== 'object') throw new Error('invalid-track-repair-version');
  const existing = await db.trackSnapshots.where('tripId').equals(tripId).filter((row) => row.snapshotId).toArray();
  const groups = groupRepairVersions(tripId, existing);
  const version = Math.max(0, ...[...groups.values()].map((rows) => rows[0].repairVersion)) + 1;
  const versionId = uuid();
  const createdAt = Date.now();
  const analysis = {
    sourceUpdatedAt: metadata.sourceUpdatedAt,
    sourceFingerprint: metadata.sourceFingerprint,
    previewId: metadata.previewId,
    selectedCategories: [...metadata.selectedCategories],
    summary: metadata.summary,
    metrics: metadata.metrics,
    semantics: metadata.semantics
  };
  for (const segment of segments) {
    const points = segment.points || [];
    const size = Math.max(1, points.length);
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      await db.trackSnapshots.add({
        id: uuid(), tripId, segmentId: segment.id, segmentIndex: segment.index,
        seq: Math.floor(offset / CHUNK_SIZE), createdAt,
        points: points.slice(offset, offset + CHUNK_SIZE).map((point) => ({ ...point })),
        snapshotId: versionId, kind: 'repair', repairVersion: version, ...analysis
      });
    }
  }
  return { versionId, version, createdAt };
}

export async function saveTrackRepairVersion(tripId, segments, metadata) {
  return db.transaction('rw', [db.trackSnapshots], () => saveTrackRepairVersionInTx(tripId, segments, metadata));
}

export async function listTrackRepairVersions(tripId): Promise<TrackRepairVersionSummary[]> {
  const rows = await db.trackSnapshots.where('tripId').equals(tripId).toArray();
  const groups = groupRepairVersions(tripId, rows.filter((row) => row.snapshotId));
  return [...groups].map(([versionId, versionRows]) => repairVersionSummary(versionId, versionRows))
    .sort((a, b) => b.version - a.version || b.createdAt - a.createdAt);
}

export async function loadTrackRepairVersion(tripId, versionId) {
  if (typeof versionId !== 'string' || !versionId) throw new Error('invalid-track-repair-version');
  const [rows, segments] = await Promise.all([
    db.trackSnapshots.where('tripId').equals(tripId).filter((row) => row.snapshotId === versionId).toArray(),
    db.segments.where('tripId').equals(tripId).toArray()
  ]);
  if (!rows.length) throw new Error('track-repair-version-not-found');
  const decoded = decodeTrackSnapshot(tripId, rows, segments);
  return { ...repairVersionSummary(versionId, rows), segments: decoded };
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
    db.waypoints.clear(), db.media.clear(), db.elevCache.clear(), db.shareImports.clear(), db.quarantine.clear()
  ]);
}

export interface QuarantineRecord {
  id: string;
  batchId: string;
  createdAt: number;
  sourceTable: 'segments' | 'trackChunks' | 'trackSnapshots';
  rowId: string;
  tripId: string | null;
  reason: string;
  row: any;
}

export interface DamagedIsolationPreview {
  segments: number;
  trackChunks: number;
  trackSnapshots: number;
  count: number;
  sampleIds: string[];
}

type DamagedRow = { row: any; reason: string };

function validStoredPoint(point: any) {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180
    && (point.t == null || Number.isFinite(point.t));
}

function snapshotGroupId(snapshot) {
  return snapshot.snapshotId ? `repair:${snapshot.snapshotId}` : `raw:${snapshot.tripId}`;
}

function repairMetadataSignature(row) {
  try {
    return JSON.stringify({
      tripId: row.tripId, kind: row.kind, repairVersion: row.repairVersion, createdAt: row.createdAt,
      sourceUpdatedAt: row.sourceUpdatedAt, previewId: row.previewId, sourceFingerprint: row.sourceFingerprint,
      selectedCategories: row.selectedCategories, summary: row.summary, metrics: row.metrics, semantics: row.semantics
    });
  } catch {
    return null;
  }
}

function segmentRowReason(segment, index) {
  if (!index.tripIds.has(segment?.tripId)) return 'orphan-segment';
  if (!Number.isSafeInteger(segment.index) || segment.index < 0) return 'malformed-segment';
  return '';
}

function chunkRowReason(chunk, index) {
  const segment = index.segments.get(chunk?.segmentId);
  if (!index.tripIds.has(chunk?.tripId) || !segment || segment.tripId !== chunk.tripId
    || index.invalidSegmentIds.has(segment.id)) return 'orphan-track-chunk';
  if (!Number.isSafeInteger(chunk.seq) || chunk.seq < 0 || !Array.isArray(chunk.points)) return 'malformed-track-chunk';
  if (chunk.points.some((point) => !validStoredPoint(point))) return 'invalid-track-point';
  return '';
}

function snapshotRowReason(snapshot, index) {
  const segment = index.segments.get(snapshot?.segmentId);
  if (!index.tripIds.has(snapshot?.tripId) || !segment || segment.tripId !== snapshot.tripId
    || index.invalidSegmentIds.has(segment.id)) return 'orphan-track-snapshot';
  if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0
    || !Number.isSafeInteger(snapshot.segmentIndex) || snapshot.segmentIndex !== segment.index
    || !Number.isFinite(snapshot.createdAt) || !Array.isArray(snapshot.points)) return 'malformed-track-snapshot';
  if (snapshot.points.some((point) => !validStoredPoint(point))) return 'invalid-snapshot-point';
  if (snapshot.snapshotId != null) {
    try { validateRepairMetadata(snapshot, snapshot.tripId); }
    catch { return 'malformed-track-repair-version'; }
  } else if (snapshot.kind != null || snapshot.repairVersion != null) {
    return 'malformed-track-snapshot';
  }
  return '';
}

function addSequenceRow(sequences: Map<string, Map<number, Set<string>>>, ownerId: string, seq: number, rowId: string) {
  let segmentSequences = sequences.get(ownerId);
  if (!segmentSequences) sequences.set(ownerId, segmentSequences = new Map());
  let ids = segmentSequences.get(seq);
  if (!ids) segmentSequences.set(seq, ids = new Set());
  ids.add(rowId);
}

function segmentSequenceProblemIds(segmentSequences: Map<number, Set<string>> | undefined) {
  const problems = new Set<string>();
  if (!segmentSequences) return problems;
  const seqs = [...segmentSequences.keys()].sort((a, b) => a - b);
  const broken = seqs.some((seq, index) => seq !== index)
    || [...segmentSequences.values()].some((ids) => ids.size !== 1);
  if (broken) for (const ids of segmentSequences.values()) for (const id of ids) problems.add(id);
  return problems;
}

function sequenceProblemIds(sequences: Map<string, Map<number, Set<string>>> | undefined) {
  const problems = new Set<string>();
  if (!sequences) return problems;
  for (const segmentSequences of sequences.values()) {
    for (const id of segmentSequenceProblemIds(segmentSequences)) problems.add(id);
  }
  return problems;
}

async function buildTrackLedgerIndex() {
  const index: any = {
    tripIds: new Set<string>(), segments: new Map(), segmentIndexes: new Map(),
    invalidSegmentIds: new Set<string>(), segmentReasons: new Map(),
    chunkSequences: new Map(), chunkReasons: new Map(),
    snapshotGroups: new Map(), repairVersionGroups: new Map(), snapshotReasons: new Map()
  };
  await db.trips.each((trip) => { if (trip?.id) index.tripIds.add(trip.id); });
  await db.segments.each((segment) => {
    if (!segment?.id) return;
    const reason = segmentRowReason(segment, index);
    if (reason) {
      index.invalidSegmentIds.add(segment.id);
      index.segmentReasons.set(segment.id, reason);
      return;
    }
    index.segments.set(segment.id, { tripId: segment.tripId, index: segment.index });
    let indexes = index.segmentIndexes.get(segment.tripId);
    if (!indexes) index.segmentIndexes.set(segment.tripId, indexes = new Map());
    let ids = indexes.get(segment.index);
    if (!ids) indexes.set(segment.index, ids = new Set());
    ids.add(segment.id);
  });
  await db.trackChunks.each((chunk) => {
    if (!chunk?.id) return;
    const reason = chunkRowReason(chunk, index);
    if (reason) index.chunkReasons.set(chunk.id, reason);
    const segment = index.segments.get(chunk.segmentId);
    if (segment && Number.isSafeInteger(chunk.seq) && chunk.seq >= 0) {
      addSequenceRow(index.chunkSequences, chunk.segmentId, chunk.seq, chunk.id);
    }
  });
  for (const [segmentId, sequences] of index.chunkSequences) {
    for (const id of segmentSequenceProblemIds(sequences)) {
      if (!index.chunkReasons.has(id)) index.chunkReasons.set(id, 'malformed-track-chunk');
    }
    if (!sequences.size) index.chunkSequences.delete(segmentId);
  }
  await db.trackSnapshots.each((snapshot) => {
    if (!snapshot?.id) return;
    const reason = snapshotRowReason(snapshot, index);
    if (reason) index.snapshotReasons.set(snapshot.id, reason);
    const groupId = snapshotGroupId(snapshot);
    let group = index.snapshotGroups.get(groupId);
    if (!group) index.snapshotGroups.set(groupId, group = {
      tripId: snapshot.tripId, signature: repairMetadataSignature(snapshot), ids: new Set(), sequences: new Map()
    });
    group.ids.add(snapshot.id);
    const signature = repairMetadataSignature(snapshot);
    if (!signature || signature !== group.signature
      || (snapshot.snapshotId && reason === 'malformed-track-repair-version')) {
      group.metadataInvalid = true;
      index.snapshotReasons.set(snapshot.id, 'malformed-track-repair-version');
    }
    if (snapshot.snapshotId && Number.isSafeInteger(snapshot.repairVersion)) {
      const versionKey = `${snapshot.tripId}:${snapshot.repairVersion}`;
      const owner = index.repairVersionGroups.get(versionKey);
      if (owner && owner !== groupId) {
        group.metadataInvalid = true;
        const previous = index.snapshotGroups.get(owner);
        if (previous) previous.metadataInvalid = true;
      } else index.repairVersionGroups.set(versionKey, groupId);
    }
    const segment = index.segments.get(snapshot.segmentId);
    if (segment && Number.isSafeInteger(snapshot.seq) && snapshot.seq >= 0) {
      addSequenceRow(group.sequences, snapshot.segmentId, snapshot.seq, snapshot.id);
    }
  });
  for (const group of index.snapshotGroups.values()) {
    if (group.metadataInvalid) {
      for (const id of group.ids) index.snapshotReasons.set(id, 'malformed-track-repair-version');
    }
    for (const id of sequenceProblemIds(group.sequences)) {
      if (!index.snapshotReasons.has(id)) index.snapshotReasons.set(id, 'malformed-track-snapshot');
    }
  }
  return index;
}

async function findDamagedRows() {
  const index = await buildTrackLedgerIndex();
  const segments: DamagedRow[] = [];
  const trackChunks: DamagedRow[] = [];
  const trackSnapshots: DamagedRow[] = [];
  await db.segments.each((row) => {
    const reason = index.segmentReasons.get(row?.id);
    if (reason) segments.push({ row, reason });
  });
  await db.trackChunks.each((row) => {
    const reason = index.chunkReasons.get(row?.id);
    if (reason) trackChunks.push({ row, reason });
  });
  await db.trackSnapshots.each((row) => {
    const reason = index.snapshotReasons.get(row?.id);
    if (reason) trackSnapshots.push({ row, reason });
  });
  return { segments, trackChunks, trackSnapshots };
}

export async function previewDamagedIsolation(): Promise<DamagedIsolationPreview> {
  return db.transaction('r', [db.trips, db.segments, db.trackChunks, db.trackSnapshots], async () => {
    const damaged = await findDamagedRows();
    const count = damaged.segments.length + damaged.trackChunks.length + damaged.trackSnapshots.length;
    return {
      segments: damaged.segments.length,
      trackChunks: damaged.trackChunks.length,
      trackSnapshots: damaged.trackSnapshots.length,
      count,
      sampleIds: [...damaged.segments, ...damaged.trackChunks, ...damaged.trackSnapshots]
        .slice(0, 5).map(({ row }) => row.id)
    };
  });
}

/** Copies damaged rows into durable quarantine before atomically removing them from active storage. */
export async function isolateDamaged(): Promise<number> {
  return db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.trackSnapshots, db.quarantine], async () => {
    const damaged = await findDamagedRows();
    const batchId = uuid();
    const createdAt = Date.now();
    const records: QuarantineRecord[] = [];
    const collect = (sourceTable: QuarantineRecord['sourceTable'], entries: DamagedRow[]) => {
      for (const { row, reason } of entries) {
        records.push({
          id: uuid(), batchId, createdAt, sourceTable, rowId: row.id,
          tripId: typeof row.tripId === 'string' ? row.tripId : null, reason, row
        });
      }
    };
    collect('segments', damaged.segments);
    collect('trackChunks', damaged.trackChunks);
    collect('trackSnapshots', damaged.trackSnapshots);
    if (!records.length) return 0;
    await db.quarantine.bulkAdd(records);
    if (damaged.trackChunks.length) await db.trackChunks.bulkDelete(damaged.trackChunks.map(({ row }) => row.id));
    if (damaged.trackSnapshots.length) await db.trackSnapshots.bulkDelete(damaged.trackSnapshots.map(({ row }) => row.id));
    if (damaged.segments.length) await db.segments.bulkDelete(damaged.segments.map(({ row }) => row.id));
    return records.length;
  });
}

export async function listQuarantinedRows(): Promise<QuarantineRecord[]> {
  return db.quarantine.orderBy('createdAt').reverse().toArray();
}

export async function restoreQuarantinedRows(ids?: string[]) {
  return db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.trackSnapshots, db.quarantine], async () => {
    const requested = new Set(ids || []);
    const records = (await db.quarantine.toArray()).filter((record) => !ids || requested.has(record.id));
    const index = await buildTrackLedgerIndex();
    const accepted = new Set<string>();
    const acceptedSegments: any[] = [];
    const acceptedChunks: any[] = [];
    const acceptedSnapshots: any[] = [];

    for (const record of records.filter((entry) => entry.sourceTable === 'segments')) {
      const row = record.row;
      if (!row?.id || await db.segments.get(row.id) || segmentRowReason(row, index)) continue;
      let indexes = index.segmentIndexes.get(row.tripId);
      if (!indexes) index.segmentIndexes.set(row.tripId, indexes = new Map());
      if (indexes.has(row.index)) continue;
      let idsAtIndex = indexes.get(row.index);
      if (!idsAtIndex) indexes.set(row.index, idsAtIndex = new Set());
      idsAtIndex.add(row.id);
      index.segments.set(row.id, { tripId: row.tripId, index: row.index });
      accepted.add(record.id);
      acceptedSegments.push(row);
    }

    const chunkCandidates = new Map<string, any[]>();
    for (const record of records.filter((entry) => entry.sourceTable === 'trackChunks')) {
      const row = record.row;
      if (!row?.id || accepted.has(record.id) || await db.trackChunks.get(row.id) || chunkRowReason(row, index)) continue;
      let rows = chunkCandidates.get(row.segmentId);
      if (!rows) chunkCandidates.set(row.segmentId, rows = []);
      rows.push({ record, row });
    }
    for (const [segmentId, candidates] of chunkCandidates) {
      const bySequence = new Map<number, any[]>();
      for (const candidate of candidates) {
        let rows = bySequence.get(candidate.row.seq);
        if (!rows) bySequence.set(candidate.row.seq, rows = []);
        rows.push(candidate);
      }
      const staged: any[] = [];
      for (const [seq, rows] of bySequence) {
        const current = index.chunkSequences.get(segmentId)?.get(seq);
        if (current?.size || rows.length !== 1) continue;
        const candidate = rows[0];
        addSequenceRow(index.chunkSequences, segmentId, seq, candidate.row.id);
        accepted.add(candidate.record.id);
        staged.push(candidate);
      }
      if (segmentSequenceProblemIds(index.chunkSequences.get(segmentId)).size) {
        for (const candidate of staged) {
          accepted.delete(candidate.record.id);
          index.chunkSequences.get(segmentId)?.get(candidate.row.seq)?.delete(candidate.row.id);
        }
      }
    }
    for (const record of records) {
      if (accepted.has(record.id) && record.sourceTable === 'trackChunks') acceptedChunks.push(record.row);
    }

    const snapshotCandidates = new Map<string, any[]>();
    for (const record of records.filter((entry) => entry.sourceTable === 'trackSnapshots')) {
      const row = record.row;
      if (!row?.id || accepted.has(record.id) || await db.trackSnapshots.get(row.id) || snapshotRowReason(row, index)) continue;
      const groupId = snapshotGroupId(row);
      let rows = snapshotCandidates.get(groupId);
      if (!rows) snapshotCandidates.set(groupId, rows = []);
      rows.push({ record, row });
    }
    const candidateVersions = new Map<string, string>();
    const duplicateVersionGroups = new Set<string>();
    for (const [groupId, candidates] of snapshotCandidates) {
      const row = candidates[0].row;
      if (!row.snapshotId) continue;
      const versionKey = `${row.tripId}:${row.repairVersion}`;
      const owner = candidateVersions.get(versionKey);
      if (owner && owner !== groupId) {
        duplicateVersionGroups.add(groupId);
        duplicateVersionGroups.add(owner);
      } else candidateVersions.set(versionKey, groupId);
    }
    for (const [groupId, candidates] of snapshotCandidates) {
      if (duplicateVersionGroups.has(groupId)) continue;
      const first = candidates[0].row;
      const signature = repairMetadataSignature(first);
      let group = index.snapshotGroups.get(groupId);
      if (group?.metadataInvalid || !signature
        || candidates.some(({ row }) => repairMetadataSignature(row) !== signature)) continue;
      if (first.snapshotId) {
        const versionKey = `${first.tripId}:${first.repairVersion}`;
        const owner = index.repairVersionGroups.get(versionKey);
        if (owner && owner !== groupId) continue;
      }
      if (!group) {
        group = { tripId: first.tripId, signature, ids: new Set(), sequences: new Map() };
        index.snapshotGroups.set(groupId, group);
      }
      const bySegment = new Map<string, Map<number, any[]>>();
      for (const candidate of candidates) {
        let bySequence = bySegment.get(candidate.row.segmentId);
        if (!bySequence) bySegment.set(candidate.row.segmentId, bySequence = new Map());
        let rows = bySequence.get(candidate.row.seq);
        if (!rows) bySequence.set(candidate.row.seq, rows = []);
        rows.push(candidate);
      }
      for (const [segmentId, bySequence] of bySegment) {
        const staged: any[] = [];
        for (const [seq, rows] of bySequence) {
          const current = group.sequences.get(segmentId)?.get(seq);
          if (current?.size || rows.length !== 1) continue;
          const candidate = rows[0];
          addSequenceRow(group.sequences, segmentId, seq, candidate.row.id);
          group.ids.add(candidate.row.id);
          accepted.add(candidate.record.id);
          staged.push(candidate);
        }
        if (segmentSequenceProblemIds(group.sequences.get(segmentId)).size) {
          for (const candidate of staged) {
            accepted.delete(candidate.record.id);
            group.ids.delete(candidate.row.id);
            group.sequences.get(segmentId)?.get(candidate.row.seq)?.delete(candidate.row.id);
          }
        }
      }
      if (first.snapshotId && [...accepted].some((id) => candidates.some(({ record }) => record.id === id))) {
        index.repairVersionGroups.set(`${first.tripId}:${first.repairVersion}`, groupId);
      }
    }
    for (const record of records) {
      if (accepted.has(record.id) && record.sourceTable === 'trackSnapshots') acceptedSnapshots.push(record.row);
    }

    for (const row of acceptedSegments) await db.segments.put(row);
    for (const row of acceptedChunks) await db.trackChunks.put(row);
    for (const row of acceptedSnapshots) await db.trackSnapshots.put(row);
    if (accepted.size) await db.quarantine.bulkDelete([...accepted]);
    return { restored: accepted.size, skipped: records.length - accepted.size };
  });
}

export async function discardQuarantinedRows(ids: string[]) {
  if (!ids.length) return 0;
  return db.transaction('rw', db.quarantine, async () => {
    const existing = await db.quarantine.bulkGet(ids);
    await db.quarantine.bulkDelete(ids);
    return existing.filter(Boolean).length;
  });
}