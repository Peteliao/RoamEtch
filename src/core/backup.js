// Full-database backup / restore as a .trip ZIP archive (JSON tables + media binaries).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db, deleteTrip } from './store.js';
import { emit } from './events.js';

const FORMAT = 'localtrace-backup';
const VERSION = 1;

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportBackup() {
  const [trips, segments, trackChunks, waypoints, media, elevCache] = await Promise.all([
    db.trips.toArray(), db.segments.toArray(), db.trackChunks.toArray(),
    db.waypoints.toArray(), db.media.toArray(), db.elevCache.toArray()
  ]);
  const manifest = {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
    counts: { trips: trips.length, waypoints: waypoints.length, media: media.length },
    trips, segments, trackChunks, waypoints,
    mediaMeta: media.map((m) => ({ id: m.id, tripId: m.tripId, width: m.width, height: m.height, createdAt: m.createdAt })),
    elevCache
  };
  const files = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
  for (const m of media) {
    files[`media/${m.id}.jpg`] = await blobToU8(m.blob);
    if (m.thumb) files[`media/${m.id}.thumb.jpg`] = await blobToU8(m.thumb);
  }
  const zipped = zipSync(files, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return { blob, filename: `trackmint-backup-${stamp}.trip`, tripCount: trips.length };
}

export async function inspectBackup(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  let files;
  try { files = unzipSync(u8); } catch { throw new Error('not a zip'); }
  if (!files['manifest.json']) throw new Error('missing manifest');
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.format !== FORMAT) throw new Error('wrong format');
  const existing = new Set((await db.trips.toArray()).map((t) => t.id));
  const conflicts = manifest.trips.filter((t) => existing.has(t.id)).map((t) => t.id);
  return { manifest, files, conflicts };
}

/** strategy: 'skip' | 'overwrite' */
export async function restoreBackup(file, strategy = 'skip') {
  const { manifest, files, conflicts } = await inspectBackup(file);
  if (strategy === 'overwrite') {
    for (const id of conflicts) await deleteTrip(id);
  }
  const skipIds = new Set(strategy === 'skip' ? conflicts : []);
  let restored = 0;
  await db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.waypoints, db.media, db.elevCache], async () => {
    for (const t of manifest.trips) {
      if (skipIds.has(t.id)) continue;
      await db.trips.put(t);
      restored++;
    }
    for (const s of manifest.segments) if (!skipIds.has(s.tripId)) await db.segments.put(s);
    for (const c of manifest.trackChunks) if (!skipIds.has(c.tripId)) await db.trackChunks.put(c);
    for (const w of manifest.waypoints) if (!skipIds.has(w.tripId)) await db.waypoints.put(w);
    for (const e of manifest.elevCache || []) await db.elevCache.put(e);
    for (const m of manifest.mediaMeta || []) {
      if (skipIds.has(m.tripId)) continue;
      const blobData = files[`media/${m.id}.jpg`];
      const thumbData = files[`media/${m.id}.thumb.jpg`];
      if (!blobData) continue;
      await db.media.put({
        ...m,
        blob: new Blob([blobData], { type: 'image/jpeg' }),
        thumb: thumbData ? new Blob([thumbData], { type: 'image/jpeg' }) : null
      });
    }
  });
  emit('backup:restored', { restored });
  return restored;
}