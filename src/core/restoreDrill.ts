import Dexie from 'dexie';
import { unzipSync, zipSync } from 'fflate';
import {
  exportBackup, inspectBackup, restoreBackup,
  type BackupTarget
} from './backup';
import { sha256Hex, stableStringify } from './integrity';
import { DATABASE_MIGRATIONS, TRIP_SCHEMA_VERSION } from './migrations';

const TABLE_NAMES = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media', 'elevCache', 'shareImports'] as const;
const COUNT_NAMES = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media'] as const;
const CLEANUP_TIMEOUT_MS = 3000;
const TRIP_ID = 'restore-drill-trip';
const SEGMENT_ID = 'restore-drill-segment';
const CHUNK_ID = 'restore-drill-chunk';
const SNAPSHOT_ID = 'restore-drill-snapshot';
const WAYPOINT_ID = 'restore-drill-waypoint';
const MEDIA_ID = 'restore-drill-media';
const CONFLICT_NAME = 'Restore drill conflict sentinel';
const BASE_TIME = 1_700_000_000_000;

export interface RestoreDrillCounts {
  trips: number;
  segments: number;
  trackChunks: number;
  trackSnapshots: number;
  waypoints: number;
  media: number;
}

export interface RestoreDrillChecks {
  manifest: boolean;
  integrity: boolean;
  rows: boolean;
  coordinates: boolean;
  timestamps: boolean;
  media: boolean;
  skip: boolean;
  overwrite: boolean;
  corruptionRejected: boolean;
  atomicRollback: boolean;
}

export interface RestoreDrillProgress {
  phase: 'prepare' | 'inspect' | 'restore' | 'verify' | 'conflict' | 'corruption' | 'cleanup';
  loaded?: number;
  total?: number;
}

interface RestoreDrillDatabase extends BackupTarget {
  name: string;
  version: any;
  open: any;
  close: any;
  delete: any;
  on: any;
}

export interface RestoreDrillOptions {
  signal?: AbortSignal;
  onProgress?: (progress: RestoreDrillProgress) => void;
  /** Maximum wait for each temporary database deletion. Defaults to 3000ms. */
  cleanupTimeoutMs?: number;
}

export interface RestoreDrillErrorInfo {
  code: string;
  message: string;
}

export interface RestoreDrillResult {
  ok: boolean;
  supported: boolean;
  status: 'ok' | 'failed' | 'aborted' | 'unsupported';
  counts: RestoreDrillCounts;
  /** Number of verified binary entries, including both originals and thumbnails. */
  mediaChecked: number;
  durationMs: number;
  checks: RestoreDrillChecks;
  cleanup: { closed: boolean; deleted: boolean; blocked: boolean; databases: number };
  error: RestoreDrillErrorInfo | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  'restore-drill-unsupported': 'Restore drill is unsupported in this environment.',
  'restore-drill-aborted': 'Restore drill was aborted.',
  'restore-drill-open-failed': 'A temporary drill database could not be opened.',
  'restore-drill-fixture-failed': 'The restore drill fixture could not be prepared.',
  'restore-drill-export-failed': 'The restore drill fixture could not be exported.',
  'restore-drill-inspect-failed': 'The restore drill archive could not be inspected.',
  'restore-drill-integrity-failed': 'The restore drill archive failed integrity verification.',
  'restore-drill-restore-failed': 'The restore drill restore failed.',
  'restore-drill-verification-failed': 'The restored drill fixture did not match the source.',
  'restore-drill-conflict-failed': 'The restore drill conflict checks failed.',
  'restore-drill-corruption-failed': 'Corrupt media was not rejected atomically.',
  'restore-drill-cleanup-failed': 'Temporary restore drill databases could not be fully removed.',
  'restore-drill-failed': 'Restore drill failed.'
};

class RestoreDrillError extends Error {
  code: string;
  constructor(code: string) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES['restore-drill-failed']);
    this.name = 'RestoreDrillError';
    this.code = code;
  }
}

let databaseSequence = 0;

function emptyCounts(): RestoreDrillCounts {
  return { trips: 0, segments: 0, trackChunks: 0, trackSnapshots: 0, waypoints: 0, media: 0 };
}

function emptyChecks(): RestoreDrillChecks {
  return {
    manifest: false, integrity: false, rows: false, coordinates: false, timestamps: false,
    media: false, skip: false, overwrite: false, corruptionRejected: false, atomicRollback: false
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw new RestoreDrillError('restore-drill-aborted');
}

async function stage<T>(code: string, signal: AbortSignal | undefined, action: () => Promise<T> | T): Promise<T> {
  throwIfAborted(signal);
  try {
    return await action();
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    if (typeof error?.code === 'string' && error.code in ERROR_MESSAGES) throw error;
    throw new RestoreDrillError(code);
  }
}

function missingCapabilities(): string[] {
  const missing: string[] = [];
  const idb = globalThis.indexedDB as any;
  if (!idb || typeof idb.open !== 'function' || typeof idb.deleteDatabase !== 'function') missing.push('indexeddb');
  if (typeof Blob !== 'function' || typeof Blob.prototype.arrayBuffer !== 'function' || typeof Blob.prototype.stream !== 'function') missing.push('blob');
  if (typeof crypto === 'undefined' || typeof crypto.subtle?.digest !== 'function') missing.push('webcrypto');
  if (typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function') missing.push('text-codec');
  return missing;
}

function createTemporaryDatabase(name: string): RestoreDrillDatabase {
  const database = new Dexie(name) as unknown as RestoreDrillDatabase;
  for (const migration of DATABASE_MIGRATIONS) {
    const version = database.version(migration.version).stores(migration.stores);
    if (migration.upgrade) version.upgrade(migration.upgrade);
  }
  return database;
}

function temporaryName(role: 'source' | 'target') {
  const nonce = `${Date.now().toString(36)}-${(++databaseSequence).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `localtrace-restore-drill-${nonce}-${role}`;
}

function fixtureBytes(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 255;
  // JPEG SOI/EOI markers keep the synthetic original and thumbnail recognizable.
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[length - 2] = 0xff; bytes[length - 1] = 0xd9;
  return bytes;
}

const ORIGINAL_BYTES = fixtureBytes(257, 0x4a);
const THUMB_BYTES = fixtureBytes(73, 0x54);
const ORIGINAL_SHA256 = 'b5c31125b09193313382a52ed8d98a8d03bc1cc86d09ed9729bee2e527d66569';
const THUMB_SHA256 = '17327d56c77665829f7d7ccff521a7f336c4a96c8d896ed0626b2754ed3ddbda';
const POINTS = [
  { lat: 30.25, lon: 120.5, t: BASE_TIME, acc: 4, ele: 12 },
  { lat: 30.2501, lon: 120.5001, t: BASE_TIME + 10_000, acc: 5, ele: 13 }
];

function createFixture() {
  return {
    trip: {
      id: TRIP_ID, name: 'Restore drill fixture', activity: 'hike', status: 'finished',
      schemaVersion: TRIP_SCHEMA_VERSION, createdAt: BASE_TIME, updatedAt: BASE_TIME + 60_000,
      privacy: { radius: 300, hideSensitive: true }, statsCache: null
    },
    segment: { id: SEGMENT_ID, tripId: TRIP_ID, index: 0, startTime: BASE_TIME, endTime: BASE_TIME + 10_000 },
    chunk: { id: CHUNK_ID, tripId: TRIP_ID, segmentId: SEGMENT_ID, seq: 0, points: POINTS.map((point) => ({ ...point })) },
    snapshot: {
      id: SNAPSHOT_ID, tripId: TRIP_ID, segmentId: SEGMENT_ID, segmentIndex: 0,
      seq: 0, createdAt: BASE_TIME + 30_000, points: POINTS.map((point) => ({ ...point }))
    },
    waypoint: {
      id: WAYPOINT_ID, tripId: TRIP_ID, lat: 30.2502, lon: 120.5002,
      time: BASE_TIME + 15_000, name: 'Drill waypoint', mediaIds: [MEDIA_ID]
    },
    media: {
      id: MEDIA_ID, tripId: TRIP_ID, width: 2, height: 2, createdAt: BASE_TIME + 20_000,
      blob: new Blob([ORIGINAL_BYTES], { type: 'image/jpeg' }),
      thumb: new Blob([THUMB_BYTES], { type: 'image/jpeg' })
    }
  };
}

async function seedFixture(database: RestoreDrillDatabase, signal?: AbortSignal) {
  const fixture = createFixture();
  await database.transaction('rw', TABLE_NAMES.map((name) => database[name]), async () => {
    throwIfAborted(signal);
    await database.trips.put(fixture.trip);
    await database.segments.put(fixture.segment);
    await database.trackChunks.put(fixture.chunk);
    await database.trackSnapshots.put(fixture.snapshot);
    await database.waypoints.put(fixture.waypoint);
    await database.media.put(fixture.media);
    throwIfAborted(signal);
  });
}

function sameJson(actual: unknown, expected: unknown) {
  return stableStringify(actual) === stableStringify(expected);
}

function onlyRow(rows: any[], id: string) {
  return rows.length === 1 && rows[0]?.id === id ? rows[0] : null;
}

function equalBytes(actual: Uint8Array, expected: Uint8Array) {
  return actual.byteLength === expected.byteLength && actual.every((value, index) => value === expected[index]);
}

async function blobBytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function mediaMetaOf({ id, tripId, width, height, createdAt }: any) {
  return { id, tripId, width, height, createdAt };
}

async function verifyTarget(
  database: RestoreDrillDatabase,
  signal?: AbortSignal,
  expected: { tripName?: string; shareImports?: any[] } = {}
) {
  throwIfAborted(signal);
  const fixture = createFixture();
  const rows = await database.transaction('r', TABLE_NAMES.map((name) => database[name]), async () => {
    throwIfAborted(signal);
    const values = await Promise.all(TABLE_NAMES.map((name) => database[name].toArray()));
    throwIfAborted(signal);
    return Object.fromEntries(TABLE_NAMES.map((name, index) => [name, values[index]])) as Record<typeof TABLE_NAMES[number], any[]>;
  });
  const counts = emptyCounts();
  for (const name of COUNT_NAMES) counts[name] = rows[name].length;
  const expectedCounts = { trips: 1, segments: 1, trackChunks: 1, trackSnapshots: 1, waypoints: 1, media: 1 };
  if (!sameJson(counts, expectedCounts)) throw new RestoreDrillError('restore-drill-verification-failed');

  const trip = onlyRow(rows.trips, TRIP_ID);
  const segment = onlyRow(rows.segments, SEGMENT_ID);
  const chunk = onlyRow(rows.trackChunks, CHUNK_ID);
  const snapshot = onlyRow(rows.trackSnapshots, SNAPSHOT_ID);
  const waypoint = onlyRow(rows.waypoints, WAYPOINT_ID);
  const media = onlyRow(rows.media, MEDIA_ID);
  if (!trip || !segment || !chunk || !snapshot || !waypoint || !media
    || !sameJson(trip, { ...fixture.trip, name: expected.tripName ?? fixture.trip.name })
    || !sameJson(segment, fixture.segment)
    || !sameJson(chunk, fixture.chunk)
    || !sameJson(snapshot, fixture.snapshot)
    || !sameJson(waypoint, fixture.waypoint)
    || !sameJson(rows.elevCache, [])
    || !sameJson(rows.shareImports, expected.shareImports ?? [])) {
    throw new RestoreDrillError('restore-drill-verification-failed');
  }

  const { blob, thumb, ...mediaMeta } = media;
  if (!sameJson(mediaMeta, mediaMetaOf(fixture.media))) {
    throw new RestoreDrillError('restore-drill-verification-failed');
  }
  let mediaChecked = 0;
  for (const [value, expectedBytes, expectedHash] of [
    [blob, ORIGINAL_BYTES, ORIGINAL_SHA256],
    [thumb, THUMB_BYTES, THUMB_SHA256]
  ] as const) {
    throwIfAborted(signal);
    if (!value || typeof value.arrayBuffer !== 'function') throw new RestoreDrillError('restore-drill-verification-failed');
    const bytes = await blobBytes(value);
    if (!equalBytes(bytes, expectedBytes) || await sha256Hex(bytes) !== expectedHash) {
      throw new RestoreDrillError('restore-drill-verification-failed');
    }
    mediaChecked++;
  }
  throwIfAborted(signal);
  return { counts, mediaChecked };
}

async function corruptMediaArchive(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const path = `media/${MEDIA_ID}.jpg`;
  const damaged = files[path].slice();
  damaged[Math.floor(damaged.byteLength / 2)] ^= 0xff;
  files[path] = damaged;
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

async function cleanupDatabase(database: RestoreDrillDatabase, timeoutMs: number) {
  let blocked = false;
  let closed = false;
  let deleted = false;
  let unsubscribe: any;
  try { unsubscribe = database.on?.('blocked', () => { blocked = true; }); } catch { /* best effort */ }
  try {
    database.close({ disableAutoOpen: true });
    closed = true;
  } catch { /* deletion is still attempted below */ }

  let timer: any;
  try {
    const deletion = Promise.resolve().then(() => database.delete({ disableAutoOpen: true })).then(() => true, () => false);
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    deleted = await Promise.race([deletion, timeout]) === true;
  } catch {
    deleted = false;
  } finally {
    clearTimeout(timer);
    try { if (typeof unsubscribe === 'function') unsubscribe(); } catch { /* best effort */ }
  }
  return { closed, deleted, blocked };
}

function errorInfo(error: any, signal?: AbortSignal): RestoreDrillErrorInfo {
  if (signal?.aborted || error?.name === 'AbortError') {
    return { code: 'restore-drill-aborted', message: ERROR_MESSAGES['restore-drill-aborted'] };
  }
  const code = typeof error?.code === 'string' && error.code in ERROR_MESSAGES
    ? error.code
    : 'restore-drill-failed';
  return { code, message: ERROR_MESSAGES[code] };
}

/**
 * Exercises the production v3 export/inspect/restore pipeline using only synthetic
 * rows in uniquely named temporary databases. The main database is never a target.
 */
export async function runRestoreDrill(options: RestoreDrillOptions = {}): Promise<RestoreDrillResult> {
  const startedAt = Date.now();
  const signal = options.signal;
  const databases: RestoreDrillDatabase[] = [];
  const result: RestoreDrillResult = {
    ok: false, supported: false, status: 'failed', counts: emptyCounts(), mediaChecked: 0,
    durationMs: 0, checks: emptyChecks(),
    cleanup: { closed: true, deleted: true, blocked: false, databases: 0 },
    error: null
  };
  const report = (phase: RestoreDrillProgress['phase'], progress: Omit<RestoreDrillProgress, 'phase'> = {}) => {
    throwIfAborted(signal);
    try { options.onProgress?.({ ...progress, phase }); } catch { /* observer failures do not change drill state */ }
    throwIfAborted(signal);
  };
  const target = () => databases[databases.length - 1];

  try {
    throwIfAborted(signal);
    if (missingCapabilities().length) throw new RestoreDrillError('restore-drill-unsupported');
    result.supported = true;
    report('prepare');

    for (const role of ['source', 'target'] as const) {
      const database = createTemporaryDatabase(temporaryName(role));
      databases.push(database);
      database.on('versionchange', () => database.close({ disableAutoOpen: true }));
    }
    await stage('restore-drill-open-failed', signal, async () => {
      await databases[0].open();
      await databases[1].open();
    });
    await stage('restore-drill-fixture-failed', signal, () => seedFixture(databases[0], signal));
    const backup = await stage('restore-drill-export-failed', signal, () => exportBackup({ target: databases[0] }));
    throwIfAborted(signal);

    report('inspect');
    const inspected = await stage('restore-drill-inspect-failed', signal, () => inspectBackup(backup.blob, '', {
      target: databases[1], signal,
      onProgress: (progress) => report('inspect', progress)
    }));
    if (inspected.manifest.version !== 3 || inspected.manifest.tripSchemaVersion !== TRIP_SCHEMA_VERSION
      || inspected.integrity.ok !== true || inspected.integrity.checked !== 2 || inspected.integrity.failed.length
      || inspected.conflicts.length) {
      throw new RestoreDrillError('restore-drill-integrity-failed');
    }
    result.checks.manifest = true;
    result.checks.integrity = true;

    report('restore');
    const restored = await stage('restore-drill-restore-failed', signal, () => restoreBackup(backup.blob, 'skip', inspected, {
      target: databases[1], signal,
      onProgress: (progress) => report('restore', progress)
    }));
    if (restored !== 1) throw new RestoreDrillError('restore-drill-verification-failed');
    report('verify');
    const verified = await verifyTarget(databases[1], signal);
    result.checks.rows = true;
    result.checks.coordinates = true;
    result.checks.timestamps = true;
    result.checks.media = true;

    report('conflict');
    const shareImport = { fingerprint: 'restore-drill-fingerprint', tripId: TRIP_ID, createdAt: BASE_TIME + 40_000 };
    await stage('restore-drill-conflict-failed', signal, () => databases[1].transaction('rw', [databases[1].trips, databases[1].shareImports], async () => {
      const current = await databases[1].trips.get(TRIP_ID);
      if (!current) throw new RestoreDrillError('restore-drill-verification-failed');
      await databases[1].trips.put({ ...current, name: CONFLICT_NAME });
      await databases[1].shareImports.put(shareImport);
    }));
    const conflictInspection = await stage('restore-drill-conflict-failed', signal, () => inspectBackup(backup.blob, '', {
      target: databases[1], signal
    }));
    if (!sameJson(conflictInspection.conflicts, [TRIP_ID])) throw new RestoreDrillError('restore-drill-conflict-failed');
    const skipped = await stage('restore-drill-conflict-failed', signal, () => restoreBackup(backup.blob, 'skip', conflictInspection, {
      target: databases[1], signal
    }));
    if (skipped !== 0) throw new RestoreDrillError('restore-drill-conflict-failed');
    await verifyTarget(databases[1], signal, { tripName: CONFLICT_NAME, shareImports: [shareImport] });
    result.checks.skip = true;

    const overwritten = await stage('restore-drill-conflict-failed', signal, () => restoreBackup(backup.blob, 'overwrite', conflictInspection, {
      target: databases[1], signal
    }));
    if (overwritten !== 1) throw new RestoreDrillError('restore-drill-conflict-failed');
    await verifyTarget(databases[1], signal);
    result.checks.overwrite = true;

    report('corruption');
    const damaged = await stage('restore-drill-corruption-failed', signal, () => corruptMediaArchive(backup.blob));
    const damagedInspection = await stage('restore-drill-corruption-failed', signal, () => inspectBackup(damaged, '', {
      target: databases[1], signal
    }));
    if (damagedInspection.integrity.ok !== false
      || !damagedInspection.integrity.failed.includes(`media/${MEDIA_ID}.jpg`)) {
      throw new RestoreDrillError('restore-drill-corruption-failed');
    }
    let rejected = false;
    try {
      await restoreBackup(damaged, 'overwrite', damagedInspection, { target: databases[1], signal });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      rejected = error?.message === 'backup integrity check failed';
    }
    if (!rejected) throw new RestoreDrillError('restore-drill-corruption-failed');
    await verifyTarget(databases[1], signal);
    result.checks.corruptionRejected = true;
    result.checks.atomicRollback = true;

    result.counts = verified.counts;
    result.mediaChecked = verified.mediaChecked;
    result.ok = true;
    result.status = 'ok';
  } catch (error) {
    result.ok = false;
    if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'restore-drill-aborted') {
      result.status = 'aborted';
    } else if (error?.code === 'restore-drill-unsupported' || error?.name === 'MissingAPIError' || error?.name === 'SecurityError') {
      result.supported = false;
      result.status = 'unsupported';
      result.error = { code: 'restore-drill-unsupported', message: ERROR_MESSAGES['restore-drill-unsupported'] };
    } else {
      result.status = 'failed';
      result.error = errorInfo(error, signal);
    }
    if (!result.error) result.error = errorInfo(error, signal);
  } finally {
    try { options.onProgress?.({ phase: 'cleanup' }); } catch { /* cleanup must still run */ }
    const timeoutMs = Number.isFinite(options.cleanupTimeoutMs) && options.cleanupTimeoutMs! > 0
      ? Math.min(30_000, Math.max(1, Math.ceil(options.cleanupTimeoutMs!)))
      : CLEANUP_TIMEOUT_MS;
    const outcomes = await Promise.all(databases.map((database) => cleanupDatabase(database, timeoutMs)));
    result.cleanup = {
      closed: outcomes.every((outcome) => outcome.closed),
      deleted: outcomes.every((outcome) => outcome.deleted),
      blocked: outcomes.some((outcome) => outcome.blocked),
      databases: databases.length
    };
    result.durationMs = Math.max(0, Date.now() - startedAt);
    if (!result.cleanup.closed || !result.cleanup.deleted) {
      result.ok = false;
      if (result.status !== 'aborted') result.status = 'failed';
      result.error = { code: 'restore-drill-cleanup-failed', message: ERROR_MESSAGES['restore-drill-cleanup-failed'] };
    }
  }
  return result;
}
