// Full-database backup / restore as a .trip ZIP archive (JSON tables + media binaries).
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { db } from './store';
import { emit } from './events';
import { sha256Hex, stableStringify } from './integrity';
import { decryptBackupBytes, encryptBackupBlob, ENCRYPTED_BACKUP_EXT, isEncryptedBackupBytes } from './backupCrypto';

const FORMAT = 'localtrace-backup';
const VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, 2]);

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_POINTS = 3_000_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MEDIA_PATH = /^media\/[A-Za-z0-9_-]{1,80}(?:\.thumb)?\.jpg$/;

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

export async function exportBackup({ password = '' }: { password?: string } = {}) {
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
  const stamp = exportedAt.slice(0, 10).replace(/-/g, '');
  const encrypted = !!password;
  const blob = encrypted
    ? await encryptBackupBlob(new Blob([zipped], { type: 'application/zip' }), password)
    : new Blob([zipped], { type: 'application/zip' });
  const filename = encrypted
    ? `trackmint-backup-${stamp}${ENCRYPTED_BACKUP_EXT}`
    : `trackmint-backup-${stamp}.trip`;
  return { blob, filename, tripCount: trips.length, exportedAt, counts: manifest.counts, encrypted };
}

function readZipLimited(u8) {
  let total = 0;
  let count = 0;
  const names = new Set();
  let files;
  try {
    files = unzipSync(u8, {
      filter(info) {
        count++;
        if (count > MAX_ARCHIVE_ENTRIES) throw new Error('too many files');
        if (names.has(info.name)) throw new Error('duplicate archive entry');
        names.add(info.name);
        if (info.name !== 'manifest.json' && !MEDIA_PATH.test(info.name)) throw new Error('unsafe archive path');
        if (info.originalSize > MAX_ENTRY_BYTES) throw new Error('archive entry too large');
        if (info.originalSize > 8 * 1024 * 1024 && info.size > 0 && info.originalSize / info.size > 200) {
          throw new Error('suspicious compression ratio');
        }
        total += info.originalSize;
        if (total > MAX_UNCOMPRESSED_BYTES) throw new Error('archive expands too large');
        return true;
      }
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/(too many|duplicate|unsafe|too large|suspicious|expands)/.test(msg)) throw e;
    throw new Error('not a zip');
  }
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new Error('missing manifest');
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) throw new Error('manifest too large');
  return files;
}

function invalidManifest() {
  throw new Error('invalid manifest');
}

function checkId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalidManifest();
  return value;
}

function validateManifest(manifest, files) {
  if (manifest.format !== FORMAT) throw new Error('wrong format');
  if (!SUPPORTED_VERSIONS.has(manifest.version)) throw new Error('unsupported version');
  for (const key of ['trips', 'segments', 'trackChunks', 'waypoints', 'mediaMeta', 'elevCache']) {
    if (!Array.isArray(manifest[key])) invalidManifest();
  }

  const countPairs = [
    ['trips', manifest.trips],
    ['segments', manifest.segments],
    ['trackChunks', manifest.trackChunks],
    ['waypoints', manifest.waypoints],
    ['media', manifest.mediaMeta]
  ];
  if (manifest.counts != null) {
    if (typeof manifest.counts !== 'object') invalidManifest();
    for (const [key, list] of countPairs) {
      if (key in manifest.counts && manifest.counts[key] !== list.length) invalidManifest();
    }
  }

  const tripIds = new Set();
  for (const t of manifest.trips) {
    if (!t || typeof t !== 'object') invalidManifest();
    const id = checkId(t.id);
    if (tripIds.has(id)) invalidManifest();
    tripIds.add(id);
  }

  const segTrip = new Map();
  for (const s of manifest.segments) {
    if (!s || typeof s !== 'object') invalidManifest();
    const id = checkId(s.id);
    if (segTrip.has(id) || !tripIds.has(s.tripId)) invalidManifest();
    segTrip.set(id, s.tripId);
  }

  let pointCount = 0;
  const chunkIds = new Set();
  for (const c of manifest.trackChunks) {
    if (!c || typeof c !== 'object') invalidManifest();
    const id = checkId(c.id);
    if (chunkIds.has(id) || segTrip.get(c.segmentId) !== c.tripId || !Array.isArray(c.points)) invalidManifest();
    chunkIds.add(id);
    pointCount += c.points.length;
    if (pointCount > MAX_POINTS) invalidManifest();
    for (const p of c.points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
        || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) invalidManifest();
      if (p.t != null && !Number.isFinite(p.t)) invalidManifest();
    }
  }

  const waypointIds = new Set();
  for (const w of manifest.waypoints) {
    if (!w || typeof w !== 'object') invalidManifest();
    const id = checkId(w.id);
    if (waypointIds.has(id) || !tripIds.has(w.tripId)) invalidManifest();
    waypointIds.add(id);
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)
      || Math.abs(w.lat) > 90 || Math.abs(w.lon) > 180) invalidManifest();
  }

  const mediaIds = new Set();
  for (const m of manifest.mediaMeta) {
    if (!m || typeof m !== 'object') invalidManifest();
    const id = checkId(m.id);
    if (mediaIds.has(id) || !tripIds.has(m.tripId)) invalidManifest();
    mediaIds.add(id);
    if (!files[`media/${id}.jpg`]) throw new Error('missing media');
  }

  for (const e of manifest.elevCache) {
    if (!e || typeof e !== 'object' || typeof e.key !== 'string') invalidManifest();
  }
}

export async function inspectBackup(file, password = '') {
  const maxEnvelope = MAX_BACKUP_BYTES + 1024;
  if (Number(file?.size) > maxEnvelope) throw new Error('backup file too large');
  let u8 = new Uint8Array(await file.arrayBuffer());
  if (u8.byteLength > maxEnvelope) throw new Error('backup file too large');
  const encrypted = isEncryptedBackupBytes(u8);
  if (encrypted) {
    u8 = await decryptBackupBytes(u8, password);
    if (u8.byteLength > MAX_BACKUP_BYTES) throw new Error('backup file too large');
  }
  const files = readZipLimited(u8);
  let manifest;
  try { manifest = JSON.parse(strFromU8(files['manifest.json'])); } catch { throw new Error('invalid manifest'); }
  validateManifest(manifest, files);
  const existing = new Set((await db.trips.toArray()).map((t) => t.id));
  const conflicts = manifest.trips.filter((t) => existing.has(t.id)).map((t) => t.id);
  const integrity = await verifyIntegrity(manifest, files);
  return { manifest, files, conflicts, integrity, encrypted };
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
export async function restoreBackup(file, strategy = 'skip', inspected = null) {
  if (strategy !== 'skip' && strategy !== 'overwrite') throw new Error('invalid strategy');
  const data = inspected || await inspectBackup(file);
  const { manifest, files, conflicts, integrity } = data;
  if (integrity.ok === false) throw new Error('backup integrity check failed');
  const skipIds = new Set(strategy === 'skip' ? conflicts : []);
  let restored = 0;
  const noExisting = async (table, ids) => {
    if (!ids.length) return;
    const rows = await table.bulkGet(ids);
    if (rows.some(Boolean)) throw new Error('archive id collision');
  };
  await db.transaction('rw', [db.trips, db.segments, db.trackChunks, db.waypoints, db.media, db.elevCache], async () => {
    restored = 0;
    if (strategy === 'overwrite') {
      for (const id of conflicts) {
        await db.trackChunks.where('tripId').equals(id).delete();
        await db.segments.where('tripId').equals(id).delete();
        await db.waypoints.where('tripId').equals(id).delete();
        await db.media.where('tripId').equals(id).delete();
        await db.trips.delete(id);
      }
    }
    await noExisting(db.trips, manifest.trips.filter((t) => !skipIds.has(t.id)).map((t) => t.id));
    await noExisting(db.segments, manifest.segments.filter((s) => !skipIds.has(s.tripId)).map((s) => s.id));
    await noExisting(db.trackChunks, manifest.trackChunks.filter((c) => !skipIds.has(c.tripId)).map((c) => c.id));
    await noExisting(db.waypoints, manifest.waypoints.filter((w) => !skipIds.has(w.tripId)).map((w) => w.id));
    await noExisting(db.media, manifest.mediaMeta.filter((m) => !skipIds.has(m.tripId)).map((m) => m.id));
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
      if (!blobData) throw new Error('missing media');
      const thumbData = files[`media/${m.id}.thumb.jpg`];
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
