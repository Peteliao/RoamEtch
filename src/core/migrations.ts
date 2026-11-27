export const DATABASE_NAME = 'localtrace';
export const TRIP_SCHEMA_VERSION = 1;
export const DATABASE_SCHEMA_VERSION = 4;
export const DEXIE_NATIVE_VERSION_SCALE = 10;

export function logicalDatabaseVersion(nativeVersion: number) {
  if (!Number.isSafeInteger(nativeVersion) || nativeVersion < 0) {
    throw new DatabaseMigrationError('invalid-database-version');
  }
  if (nativeVersion === 0) return 0;
  return nativeVersion % DEXIE_NATIVE_VERSION_SCALE === 0
    ? nativeVersion / DEXIE_NATIVE_VERSION_SCALE
    : Math.max(1, Math.floor(nativeVersion / DEXIE_NATIVE_VERSION_SCALE));
}

export type DatabaseTable = 'trips' | 'segments' | 'trackChunks' | 'trackSnapshots' | 'waypoints' | 'media' | 'elevCache' | 'shareImports' | 'quarantine';

export interface TripSchemaMigration {
  version: number;
  name: string;
  upgrade: (trip: any) => void;
}

export const TRIP_SCHEMA_MIGRATIONS: readonly TripSchemaMigration[] = [
  {
    version: 1,
    name: 'initial-trip-schema',
    upgrade: (trip) => { if (trip.schemaVersion == null) trip.schemaVersion = 1; }
  }
];

export function validateTripSchemaRegistry(migrations = TRIP_SCHEMA_MIGRATIONS) {
  const names = new Set<string>();
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || names.has(migration.name)) {
      throw new DatabaseMigrationError('invalid-trip-migration-registry');
    }
    names.add(migration.name);
  });
  if (migrations[migrations.length - 1]?.version !== TRIP_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('invalid-trip-migration-registry');
  }
  return true;
}

export function migrateTripRecord(trip: any) {
  assertTripSchemaVersion(trip?.schemaVersion);
  const from = trip?.schemaVersion == null ? 0 : trip.schemaVersion;
  for (const migration of TRIP_SCHEMA_MIGRATIONS) {
    if (migration.version > from) migration.upgrade(trip);
  }
  assertTripSchemaVersion(trip.schemaVersion);
  if (trip.schemaVersion !== TRIP_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('trip-migration-verification-failed');
  }
}

export interface DatabaseMigration {
  version: number;
  name: string;
  stores: Partial<Record<DatabaseTable, string>>;
  upgrade?: (tx: any) => void | Promise<void>;
}

export class DatabaseMigrationError extends Error {
  code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'DatabaseMigrationError';
    this.code = code;
  }
}

export function assertTripSchemaVersion(value: unknown): void {
  if (value == null) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new DatabaseMigrationError('invalid-trip-schema-version');
  }
  if ((value as number) > TRIP_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('future-trip-schema-version');
  }
}

async function verifyShareImportsStore(tx: any) {
  await tx.table('shareImports').count();
}

async function migrateTripSchema(tx: any) {
  const trips = tx.table('trips');
  let validationError: unknown;
  await trips.toCollection().each((trip) => {
    try {
      assertTripSchemaVersion(trip?.schemaVersion);
    } catch (error) {
      validationError ??= error;
      return false;
    }
  });
  if (validationError) throw validationError;

  await trips.toCollection().modify((trip) => {
    migrateTripRecord(trip);
  });

  let verificationError: unknown;
  await trips.toCollection().each((trip) => {
    if (trip.schemaVersion !== TRIP_SCHEMA_VERSION) {
      verificationError ??= new DatabaseMigrationError('migration-verification-failed');
      return false;
    }
  });
  if (verificationError) throw verificationError;
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: 'initial-trip-storage',
    stores: {
      trips: 'id, updatedAt, status',
      segments: 'id, tripId, [tripId+index]',
      trackChunks: 'id, tripId, segmentId, [segmentId+seq]',
      waypoints: 'id, tripId, time',
      media: 'id, tripId',
      elevCache: 'key, fetchedAt'
    }
  },
  {
    version: 2,
    name: 'durable-share-imports',
    stores: { shareImports: 'fingerprint, tripId, createdAt' },
    upgrade: verifyShareImportsStore
  },
  {
    version: 3,
    name: 'original-track-snapshots',
    stores: { trackSnapshots: 'id, tripId, segmentId, [tripId+segmentId], [segmentId+seq]' },
    upgrade: migrateTripSchema
  },
  {
    version: 4,
    name: 'recoverable-integrity-quarantine',
    stores: { quarantine: 'id, batchId, createdAt, sourceTable, rowId, tripId' }
  }
];

export const DATABASE_TABLES = [...new Set(DATABASE_MIGRATIONS.flatMap((migration) => Object.keys(migration.stores)))] as DatabaseTable[];

export function validateMigrationRegistry(migrations = DATABASE_MIGRATIONS) {
  const names = new Set<string>();
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || names.has(migration.name) || !Object.keys(migration.stores).length) {
      throw new DatabaseMigrationError('invalid-migration-registry');
    }
    names.add(migration.name);
  });
  if (migrations[migrations.length - 1]?.version !== DATABASE_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('invalid-migration-registry');
  }
  return true;
}

validateMigrationRegistry();
validateTripSchemaRegistry();

export type DatabasePreflightIssueType =
  | 'invalid-trip-schema-version' | 'future-trip-schema-version'
  | 'malformed-trip' | 'orphan-segment' | 'malformed-segment' | 'duplicate-segment-index'
  | 'orphan-track-chunk' | 'malformed-track-chunk' | 'invalid-track-point'
  | 'invalid-track-timestamp' | 'duplicate-chunk-seq' | 'missing-chunk-seq'
  | 'orphan-track-snapshot' | 'malformed-track-snapshot' | 'invalid-snapshot-point'
  | 'invalid-snapshot-timestamp' | 'duplicate-snapshot-seq' | 'missing-snapshot-seq'
  | 'orphan-waypoint' | 'invalid-waypoint-coords' | 'orphan-media' | 'orphan-share-import';

export interface DatabasePreflightIssue {
  type: DatabasePreflightIssueType;
  severity: 'error' | 'warning';
  count: number;
  sampleIds: string[];
}

export interface DatabasePreflightCounts extends Record<DatabaseTable, number> {
  points: number;
  snapshotPoints: number;
}

export interface DatabasePreflight {
  fromVersion: number;
  toVersion: number;
  needsUpgrade: boolean;
  skipped: boolean;
  blocking: boolean;
  ok: boolean;
  stores: string[];
  counts: DatabasePreflightCounts;
  issues: DatabasePreflightIssue[];
}

export interface DatabaseMigrationResult {
  fromVersion: number;
  toVersion: number;
  needsUpgrade: boolean;
  skipped: boolean;
  verified: boolean;
  counts: DatabasePreflightCounts;
}

function emptyCounts(): DatabasePreflightCounts {
  return {
    trips: 0, segments: 0, trackChunks: 0, trackSnapshots: 0,
    waypoints: 0, media: 0, elevCache: 0, shareImports: 0, quarantine: 0,
    points: 0, snapshotPoints: 0
  };
}

function emptyPreflight(fromVersion = 0, skipped = false): DatabasePreflight {
  return {
    fromVersion, toVersion: DATABASE_SCHEMA_VERSION,
    needsUpgrade: fromVersion < DATABASE_SCHEMA_VERSION, skipped,
    blocking: false, ok: true, stores: [], counts: emptyCounts(), issues: []
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object';
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCoords(value: unknown): boolean {
  const point = isRecord(value) ? value : null;
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function scanStore(tx: IDBTransaction, table: DatabaseTable, visit: (row: any) => void): Promise<void> {
  if (!tx.db.objectStoreNames.contains(table)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = tx.objectStore(table).openCursor();
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.onerror = () => fail(request.error);
    tx.onabort = () => fail(tx.error || new DatabaseMigrationError('migration-preflight-aborted'));
    request.onsuccess = () => {
      if (settled) return;
      try {
        const cursor = request.result;
        if (!cursor) {
          settled = true;
          resolve();
          return;
        }
        visit(cursor.value);
        cursor.continue();
      } catch (error) {
        fail(error);
      }
    };
  });
}

async function inspectSource(raw: IDBDatabase, stores: string[]): Promise<Pick<DatabasePreflight, 'counts' | 'issues' | 'ok' | 'blocking'>> {
  const counts = emptyCounts();
  const findings = new Map<DatabasePreflightIssueType, { count: number; sampleIds: Set<string>; severity: 'error' | 'warning' }>();
  const addIssue = (type: DatabasePreflightIssueType, id: string, severity: 'error' | 'warning' = 'error', count = 1) => {
    let finding = findings.get(type);
    if (!finding) {
      finding = { count: 0, sampleIds: new Set(), severity };
      findings.set(type, finding);
    }
    finding.count += count;
    if (finding.sampleIds.size < 5) finding.sampleIds.add(id);
  };
  const tripIds = new Set<string>();
  const segments = new Map<string, { tripId: string; index: number }>();
  const segmentIndexes = new Map<string, Set<number>>();
  const chunkSeqs = new Map<string, Map<number, string>>();
  const snapshotSeqs = new Map<string, Map<number, string>>();
  let blocking = false;

  const inspectTrip = (row: any) => {
    const id = isId(row?.id) ? row.id : 'trips[?]';
    if (!isId(row?.id)) addIssue('malformed-trip', id);
    else tripIds.add(row.id);
    try {
      assertTripSchemaVersion(row?.schemaVersion);
    } catch (error) {
      const type = error?.code === 'future-trip-schema-version' ? 'future-trip-schema-version' : 'invalid-trip-schema-version';
      addIssue(type, id);
      blocking = true;
    }
  };
  const inspectSegment = (row: any) => {
    const id = isId(row?.id) ? row.id : 'segments[?]';
    if (!isId(row?.id) || !isId(row?.tripId) || !isSequence(row?.index)) {
      addIssue('malformed-segment', id);
      return;
    }
    segments.set(row.id, { tripId: row.tripId, index: row.index });
    if (!tripIds.has(row.tripId)) addIssue('orphan-segment', id);
    let indexes = segmentIndexes.get(row.tripId);
    if (!indexes) {
      indexes = new Set();
      segmentIndexes.set(row.tripId, indexes);
    }
    if (indexes.has(row.index)) addIssue('duplicate-segment-index', id, 'warning');
    else indexes.add(row.index);
  };
  const inspectPoints = (points: any, id: string, snapshot: boolean) => {
    if (!Array.isArray(points)) return;
    counts[snapshot ? 'snapshotPoints' : 'points'] += points.length;
    for (const point of points) {
      if (!validCoords(point)) addIssue(snapshot ? 'invalid-snapshot-point' : 'invalid-track-point', id);
      if (isRecord(point) && point.t != null && !Number.isFinite(point.t)) {
        addIssue(snapshot ? 'invalid-snapshot-timestamp' : 'invalid-track-timestamp', id, 'warning');
      }
    }
  };
  const inspectChunk = (row: any) => {
    const id = isId(row?.id) ? row.id : 'trackChunks[?]';
    const segment = isId(row?.segmentId) ? segments.get(row.segmentId) : undefined;
    if (!isId(row?.id) || !isId(row?.tripId) || !tripIds.has(row.tripId) || !segment || segment.tripId !== row.tripId) {
      addIssue('orphan-track-chunk', id);
    }
    const validSeq = isSequence(row?.seq);
    if (!validSeq || !Array.isArray(row?.points)) addIssue('malformed-track-chunk', id);
    inspectPoints(row?.points, id, false);
    if (segment && validSeq) {
      let seqs = chunkSeqs.get(row.segmentId);
      if (!seqs) {
        seqs = new Map();
        chunkSeqs.set(row.segmentId, seqs);
      }
      if (seqs.has(row.seq)) addIssue('duplicate-chunk-seq', id);
      else seqs.set(row.seq, id);
    }
  };
  const inspectSnapshot = (row: any) => {
    const id = isId(row?.id) ? row.id : 'trackSnapshots[?]';
    const segment = isId(row?.segmentId) ? segments.get(row.segmentId) : undefined;
    if (!isId(row?.id) || !isId(row?.tripId) || !tripIds.has(row.tripId) || !segment || segment.tripId !== row.tripId) {
      addIssue('orphan-track-snapshot', id);
    }
    const validSeq = isSequence(row?.seq);
    if (!validSeq || !isSequence(row?.segmentIndex) || !Array.isArray(row?.points)
      || !Number.isFinite(row?.createdAt) || (segment && row.segmentIndex !== segment.index)) {
      addIssue('malformed-track-snapshot', id);
    }
    inspectPoints(row?.points, id, true);
    if (segment && validSeq) {
      let seqs = snapshotSeqs.get(row.segmentId);
      if (!seqs) {
        seqs = new Map();
        snapshotSeqs.set(row.segmentId, seqs);
      }
      if (seqs.has(row.seq)) addIssue('duplicate-snapshot-seq', id);
      else seqs.set(row.seq, id);
    }
  };
  const inspectWaypoint = (row: any) => {
    const id = isId(row?.id) ? row.id : 'waypoints[?]';
    if (!isId(row?.id) || !isId(row?.tripId) || !tripIds.has(row.tripId)) addIssue('orphan-waypoint', id);
    if (!validCoords(row)) addIssue('invalid-waypoint-coords', id);
  };
  const inspectMedia = (row: any) => {
    const id = isId(row?.id) ? row.id : 'media[?]';
    if (!isId(row?.id) || !isId(row?.tripId) || !tripIds.has(row.tripId)) addIssue('orphan-media', id);
  };
  const inspectShareImport = (row: any) => {
    const id = isId(row?.fingerprint) ? row.fingerprint : 'shareImports[?]';
    if (!isId(row?.fingerprint) || !tripIds.has(row?.tripId)) addIssue('orphan-share-import', id, 'warning');
  };
  const finishSequences = (sequences: Map<string, Map<number, string>>, prefix: 'chunk' | 'snapshot') => {
    for (const seqs of sequences.values()) {
      let previous = -1;
      for (const seq of [...seqs.keys()].sort((a, b) => a - b)) {
        const missing = seq - previous - 1;
        if (missing > 0) addIssue(prefix === 'chunk' ? 'missing-chunk-seq' : 'missing-snapshot-seq', seqs.get(seq)!, 'error', missing);
        previous = seq;
      }
    }
  };

  const tx = raw.transaction(stores, 'readonly');
  const visitors: Partial<Record<DatabaseTable, (row: any) => void>> = {
    trips: inspectTrip, segments: inspectSegment, trackChunks: inspectChunk,
    trackSnapshots: inspectSnapshot, waypoints: inspectWaypoint,
    media: inspectMedia, shareImports: inspectShareImport
  };
  const order: DatabaseTable[] = ['trips', 'segments', 'waypoints', 'media', 'shareImports', 'trackChunks', 'trackSnapshots', 'elevCache', 'quarantine'];
  for (const table of order) {
    if (!stores.includes(table)) continue;
    await scanStore(tx, table, (row) => {
      counts[table]++;
      visitors[table]?.(row);
    });
  }
  finishSequences(chunkSeqs, 'chunk');
  finishSequences(snapshotSeqs, 'snapshot');
  const issues = [...findings.entries()].map(([type, finding]) => ({
    type, severity: finding.severity, count: finding.count, sampleIds: [...finding.sampleIds]
  }));
  return { counts, issues, blocking, ok: !issues.some((issue) => issue.severity === 'error') };
}

function openExistingDatabase(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open(name); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => {
      if (request.error?.name === 'AbortError') resolve(null);
      else reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

export async function preflightDatabase(name = DATABASE_NAME): Promise<DatabasePreflight> {
  if (!globalThis.indexedDB) throw new DatabaseMigrationError('indexeddb-unavailable');
  if (typeof indexedDB.databases !== 'function') return emptyPreflight(0, true);
  let entries;
  try { entries = await indexedDB.databases(); } catch { return emptyPreflight(0, true); }
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) return emptyPreflight();
  const entryVersion = logicalDatabaseVersion(Number(entry.version));
  if (entryVersion > DATABASE_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('future-database-version', `Database schema ${entryVersion} is newer than ${DATABASE_SCHEMA_VERSION}`);
  }
  const raw = await openExistingDatabase(name);
  if (!raw) return emptyPreflight();
  try {
    const fromVersion = logicalDatabaseVersion(raw.version);
    if (fromVersion > DATABASE_SCHEMA_VERSION) {
      throw new DatabaseMigrationError('future-database-version', `Database schema ${fromVersion} is newer than ${DATABASE_SCHEMA_VERSION}`);
    }
    const stores = [...raw.objectStoreNames];
    const result = emptyPreflight(fromVersion);
    result.stores = stores;
    Object.assign(result, await inspectSource(raw, stores));
    return result;
  } finally {
    raw.close();
  }
}

export function migrationErrorFromPreflight(preflight: DatabasePreflight) {
  const issue = preflight.issues.find((candidate) => candidate.type === 'future-trip-schema-version' || candidate.type === 'invalid-trip-schema-version');
  return new DatabaseMigrationError(issue?.type || 'migration-preflight-failed');
}

export async function verifyDatabaseMigration(database: any, preflight: DatabasePreflight): Promise<DatabaseMigrationResult> {
  if (database.verno !== DATABASE_SCHEMA_VERSION) {
    throw new DatabaseMigrationError('migration-verification-failed', 'Unexpected database schema version after migration');
  }
  const stores = new Set([...database.tables].map((table) => table.name));
  for (const migration of DATABASE_MIGRATIONS) {
    for (const table of Object.keys(migration.stores)) {
      if (!stores.has(table)) throw new DatabaseMigrationError('migration-verification-failed', `Missing table after migration: ${table}`);
    }
  }
  const counts = emptyCounts();
  if (!preflight.skipped && preflight.needsUpgrade) {
    await Promise.all(DATABASE_TABLES.map(async (table) => { counts[table] = await database.table(table).count(); }));
    for (const table of DATABASE_TABLES) {
      if (counts[table] !== preflight.counts[table]) {
        throw new DatabaseMigrationError('migration-verification-failed', `Row count changed during migration: ${table}`);
      }
    }
  }
  let tripValidationError: unknown;
  await database.table('trips').toCollection().each((trip) => {
    try {
      assertTripSchemaVersion(trip?.schemaVersion);
      if (trip.schemaVersion !== TRIP_SCHEMA_VERSION) {
        throw new DatabaseMigrationError('migration-verification-failed');
      }
    } catch (error) {
      tripValidationError ??= error;
      return false;
    }
  });
  if (tripValidationError) throw tripValidationError;
  return {
    fromVersion: preflight.fromVersion, toVersion: DATABASE_SCHEMA_VERSION,
    needsUpgrade: preflight.needsUpgrade, skipped: preflight.skipped,
    verified: true, counts
  };
}
