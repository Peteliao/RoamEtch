// Full-database backup / restore as a .trip ZIP archive (JSON tables + media binaries).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db, deleteTrip } from './store';
import { emit } from './events';
import { sha256Hex, stableStringify } from './integrity';

const FORMAT = 'localtrace-backup';
const VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, 2]);

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function payloadOf(manifest) {
  const { integrity, ...payload } = manifest;
  return payload;
}

function payloadDigest(manifest) {
  return sha256Hex(stableStringify(payloadOf(manifest)));
}

function mediaFilesOf(files, manifest) {
  const paths = new Set([
    ...Object.keys(files).filter((p) => p.startsWith('media/')),
    ...Object.keys(manifest.integrity?.files || {})
  ]);
  for (const m of manifest.mediaMeta || []) paths.add(`media/${m.id}.jpg`);
  return [...paths];
}

export async function exportBackup() {
  const [trips, segments, trackChunks, waypoints, media, elevCache] = await Promise.all([
    db.trips.toArray(), db.segments.toArray(), db.trackChunks.toArray(),
    db.waypoints.toArray(), db.media.toArray(), db.elevCache.toArray()
  ]);
  const exportedAt = new Date().toISOString();
  const manifest: any = {
    format: FORMAT, version: VERSION, exportedAt,
    counts: {
      trips: trips.length, segments: segments.length, trackChunks: trackChunks.length,
      waypoints: waypoints.length, media: media.length
    },
    trips, segments, trackChunks, waypoints,
    mediaMeta: media.map((m) => ({ id: m.id, tripId: m.tripId, width: m.width, height: m.height, createdAt: m.createdAt })),
    elevCache
  };
  const entries = {};
  const fileHashes = {};
  for (const m of media) {
    const photo = await blobToU8(m.blob);
    const photoPath = `media/${m.id}.jpg`;
    entries[photoPath] = photo;
    fileHashes[photoPath] = { bytes: photo.byteLength, sha256: await sha256Hex(photo) };
    if (m.thumb) {
      const thumb = await blobToU8(m.thumb);
      const thumbPath = `media/${m.id}.thumb.jpg`;
      entries[thumbPath] = thumb;
      fileHashes[thumbPath] = { bytes: thumb.byteLength, sha256: await sha256Hex(thumb) };
    }
  }
  manifest.integrity = {
    algo: 'SHA-256',
    payload: await payloadDigest(manifest),
    files: fileHashes
  };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  const zipped = zipSync(entries, { level: 6 });
  const blob = new Blob([zipped], { type: 'application/zip' });
  const stamp = exportedAt.slice(0, 10).replace(/-/g, '');
  return { blob, filename: `trackmint-backup-${stamp}.trip`, tripCount: trips.length, exportedAt, counts: manifest.counts };
}

export async function inspectBackup(file) {
  const u8 = new Uint8Array(await file.arrayBuffer());
  let files;
  try { files = unzipSync(u8); } catch { throw new Error('not a zip'); }
  if (!files['manifest.json']) throw new Error('missing manifest');
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); } catch { throw new Error('invalid manifest'); }
  if (manifest.format !== FORMAT) throw new Error('wrong format');
  if (!SUPPORTED_VERSIONS.has(manifest.version)) throw new Error('unsupported version');
  for (const key of ['trips', 'segments', 'trackChunks', 'waypoints', 'mediaMeta', 'elevCache']) {
    if (!Array.isArray(manifest[key])) throw new Error('invalid manifest');
  }
  const existing = new Set((await db.trips.toArray()).map((t) => t.id));
  const conflicts = manifest.trips.filter((t) => existing.has(t.id)).map((t) => t.id);
  const integrity = await verifyIntegrity(manifest, files);
  return { manifest, files, conflicts, integrity };
}

async function verifyIntegrity(manifest, files) {
  if (!manifest.integrity) return { ok: null, checked: 0, failed: [] };
  if (manifest.integrity.algo !== 'SHA-256' || typeof manifest.integrity.payload !== 'string') {
    return { ok: false, checked: 0, failed: ['unsupported checksum'] };
  }
  const expected = manifest.integrity.payload;
  const actual = await payloadDigest(manifest);
  if (actual !== expected) return { ok: false, checked: 0, failed: ['manifest'] };
  const failed = [];
  let checked = 0;
  for (const path of mediaFilesOf(files, manifest)) {
    const meta = manifest.integrity.files?.[path];
    const data = files[path];
    if (!meta || !data) { failed.push(path); continue; }
    checked++;
    if (data.byteLength !== meta.bytes || await sha256Hex(data) !== meta.sha256) failed.push(path);
  }
  return { ok: failed.length === 0, checked, failed };
}

/** strategy: 'skip' | 'overwrite' */
export async function restoreBackup(file, strategy = 'skip') {
  const { manifest, files, conflicts, integrity } = await inspectBackup(file);
  if (integrity.ok === false) throw new Error('backup integrity check failed');
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
