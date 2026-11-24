// IndexedDB runtime schema (Dexie). All coordinates stored here are WGS-84, SI units.
import Dexie from 'dexie';
import { uuid } from './geo';

export const db = new Dexie('localtrace') as Dexie & {
  trips: any; segments: any; trackChunks: any; waypoints: any; media: any; elevCache: any;
};
db.version(1).stores({
  trips: 'id, updatedAt, status',
  segments: 'id, tripId, [tripId+index]',
  trackChunks: 'id, tripId, segmentId, [segmentId+seq]',
  waypoints: 'id, tripId, time',
  media: 'id, tripId',
  elevCache: 'key, fetchedAt'
});

export const CHUNK_SIZE = 400;

// ---------- trips ----------
export async function createTrip({ name, activity = 'hike', status = 'recording', createdAt = Date.now() }: any = {}) {
  const trip = {
    id: uuid(), name: name || '', activity, status,
    createdAt, updatedAt: Date.now(),
    privacy: { radius: 300, hideSensitive: true },
    statsCache: null
  };
  await db.trips.add(trip);
  return trip;
}
export const getTrip = (id) => db.trips.get(id);
export const listTrips = () => db.trips.orderBy('updatedAt').reverse().toArray();
export async function updateTrip(id, patch) {
  await db.trips.update(id, { ...patch, updatedAt: Date.now() });
}
export async function deleteTrip(id) {
  await db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.waypoints, db.media], async () => {
    await db.trackChunks.where('tripId').equals(id).delete();
    await db.segments.where('tripId').equals(id).delete();
    await db.waypoints.where('tripId').equals(id).delete();
    await db.media.where('tripId').equals(id).delete();
    await db.trips.delete(id);
  });
}

// ---------- segments & chunks ----------
export async function addSegment(tripId, startTime = Date.now()) {
  const count = await db.segments.where('tripId').equals(tripId).count();
  const seg = { id: uuid(), tripId, index: count, startTime, endTime: null };
  await db.segments.add(seg);
  return seg;
}
export const listSegments = (tripId) => db.segments.where('tripId').equals(tripId).sortBy('index');

export async function appendPoints(segmentId, tripId, points) {
  if (!points.length) return;
  await db.transaction('rw', [db.trackChunks, db.segments, db.trips], async () => {
    const last = await db.trackChunks.where('segmentId').equals(segmentId).last();
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
    await db.trips.update(tripId, { updatedAt: Date.now() });
  });
}

export async function loadTripFull(tripId) {
  const [trip, segments, waypoints, media] = await Promise.all([
    db.trips.get(tripId),
    listSegments(tripId),
    db.waypoints.where('tripId').equals(tripId).toArray(),
    db.media.where('tripId').equals(tripId).toArray()
  ]);
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
  return { trip, segments: segData, waypoints, media };
}

/** Replace all points of a segment (used by editor). */
export async function replaceSegmentPoints(segmentId, tripId, points) {
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
    await db.trips.update(tripId, { updatedAt: Date.now() });
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
    await db.trips.update(tripId, { updatedAt: Date.now() });
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
  if (navigator.storage?.estimate) return navigator.storage.estimate();
  return { usage: 0, quota: 0 };
}

export async function eraseAll() {
  await Promise.all([
    db.trips.clear(), db.segments.clear(), db.trackChunks.clear(),
    db.waypoints.clear(), db.media.clear(), db.elevCache.clear()
  ]);
}

/** Integrity check: isolate chunks referencing missing segments/trips. */
export async function isolateDamaged() {
  const trips = new Set((await db.trips.toArray()).map((t) => t.id));
  const segs = new Set((await db.segments.toArray()).map((s) => s.id));
  let removed = 0;
  const badChunks = [];
  await db.trackChunks.each((c) => {
    if (!trips.has(c.tripId) || !segs.has(c.segmentId) || !Array.isArray(c.points)) badChunks.push(c.id);
  });
  if (badChunks.length) { await db.trackChunks.bulkDelete(badChunks); removed += badChunks.length; }
  const badSegs = [];
  await db.segments.each((s) => { if (!trips.has(s.tripId)) badSegs.push(s.id); });
  if (badSegs.length) { await db.segments.bulkDelete(badSegs); removed += badSegs.length; }
  return removed;
}