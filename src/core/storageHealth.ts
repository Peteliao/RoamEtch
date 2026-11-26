import Dexie from 'dexie';
import { db } from './store';
import { stableStringify } from './integrity';

export type StorageHealthSeverity = 'error' | 'warning' | 'info';

const ISSUE_DEFINITIONS = {
  orphanTrackChunk: { type: 'orphan-track-chunk', severity: 'error' },
  malformedTrackChunk: { type: 'malformed-track-chunk', severity: 'error' },
  invalidTrackPoint: { type: 'invalid-track-point', severity: 'error' },
  invalidTrackTimestamp: { type: 'invalid-track-timestamp', severity: 'warning' },
  duplicateChunkSeq: { type: 'duplicate-chunk-seq', severity: 'error' },
  missingChunkSeq: { type: 'missing-chunk-seq', severity: 'error' },
  emptySegment: { type: 'empty-segment', severity: 'info' },
  orphanSegment: { type: 'orphan-segment', severity: 'error' },
  orphanTrackSnapshot: { type: 'orphan-track-snapshot', severity: 'error' },
  malformedTrackSnapshot: { type: 'malformed-track-snapshot', severity: 'error' },
  invalidSnapshotPoint: { type: 'invalid-snapshot-point', severity: 'error' },
  invalidSnapshotTimestamp: { type: 'invalid-snapshot-timestamp', severity: 'warning' },
  duplicateSnapshotSeq: { type: 'duplicate-snapshot-seq', severity: 'error' },
  missingSnapshotSeq: { type: 'missing-snapshot-seq', severity: 'error' },
  orphanWaypoint: { type: 'orphan-waypoint', severity: 'error' },
  orphanMedia: { type: 'orphan-media', severity: 'error' },
  invalidWaypointCoords: { type: 'invalid-waypoint-coords', severity: 'error' },
  possibleDuplicateFixes: { type: 'possible-duplicate-fixes', severity: 'info' },
  unreferencedMedia: { type: 'unreferenced-media', severity: 'warning' },
  missingMediaBlob: { type: 'missing-media-blob', severity: 'error' }
} as const;

export type StorageHealthIssueType =
  (typeof ISSUE_DEFINITIONS)[keyof typeof ISSUE_DEFINITIONS]['type'];

type IssueKey = keyof typeof ISSUE_DEFINITIONS;
type RecordId = string | number;

export interface StorageHealthIssue {
  type: StorageHealthIssueType;
  severity: StorageHealthSeverity;
  count: number;
  sampleIds: string[];
}

export interface StorageHealthTables {
  trips: readonly unknown[];
  segments: readonly unknown[];
  trackChunks: readonly unknown[];
  trackSnapshots: readonly unknown[];
  waypoints: readonly unknown[];
  media: readonly unknown[];
}

export interface StorageHealthCounts {
  trips: number;
  segments: number;
  trackChunks: number;
  trackSnapshots: number;
  points: number;
  snapshotPoints: number;
  waypoints: number;
  media: number;
  photoBytes: number;
}

export interface StorageHealthResult {
  /** No error-severity integrity failures were found. */
  ok: boolean;
  /** No findings at all, including informational findings, were reported. */
  healthy: boolean;
  counts: StorageHealthCounts;
  totals: StorageHealthCounts & { issues: number };
  issues: StorageHealthIssue[];
}

export interface MediaCleanupPreview {
  token: string;
  count: number;
  bytes: number;
  sampleIds: string[];
}

export interface MediaCleanupResult {
  deleted: number;
  bytes: number;
  skipped: number;
}

const MAX_SAMPLE_IDS = 20;
// FIFO eviction bounds duplicate-fix fingerprint memory on large trips.
const MAX_DUPLICATE_FIX_KEYS = 50_000;
const CLEANUP_TOKEN_TTL = 5 * 60_000;
const MAX_CLEANUP_TOKENS = 4;
const CLEANUP_LOCK = 'roametch:storage-media-cleanup';

interface CleanupTokenRecord {
  ids: RecordId[];
  bytes: number;
  createdAt: number;
}

const cleanupTokens = new Map<string, CleanupTokenRecord>();

export class MediaCleanupTokenError extends Error {
  code = 'media-cleanup-stale';
  constructor() {
    super('Storage cleanup preview is stale or was already used.');
    this.name = 'MediaCleanupTokenError';
  }
}

interface SegmentInfo {
  tripId: unknown;
  index: unknown;
  pointCount: number;
  sampleId: string;
}

function asRecord(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, any> : null;
}

function rows(value: readonly unknown[]): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecordId(value: unknown): value is RecordId {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value));
}

function isSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validCoords(value: unknown): boolean {
  const point = asRecord(value);
  return !!point && typeof point.lat === 'number' && typeof point.lon === 'number'
    && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function validTimestamp(value: unknown): boolean {
  const point = asRecord(value);
  return !!point && typeof point.t === 'number' && Number.isFinite(point.t);
}

function sampleId(value: unknown, table: string, index: number): string {
  const id = asRecord(value)?.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : `${table}[${index}]`;
}

function blobSize(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null;
  const size = (value as { size?: unknown }).size;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

// Shared by the pure and incremental APIs so findings cannot drift between them.
class StorageHealthAnalyzer {
  private readonly counts: StorageHealthCounts = {
    trips: 0,
    segments: 0,
    trackChunks: 0,
    trackSnapshots: 0,
    points: 0,
    snapshotPoints: 0,
    waypoints: 0,
    media: 0,
    photoBytes: 0
  };

  private readonly findings = new Map<IssueKey, { count: number; sampleIds: Set<string> }>();
  private readonly duplicateFixKeys = new Map<string, true>();
  private readonly tripIds = new Set<RecordId>();
  private readonly segmentsById = new Map<RecordId, SegmentInfo>();
  private readonly chunkSeqsBySegment = new Map<RecordId, Map<number, string>>();
  private readonly snapshotSeqsBySegment = new Map<RecordId, Map<number, string>>();
  private readonly referencedMediaIds = new Set<RecordId>();

  private addIssue(key: IssueKey, id: string, count = 1) {
    let finding = this.findings.get(key);
    if (!finding) {
      finding = { count: 0, sampleIds: new Set() };
      this.findings.set(key, finding);
    }
    finding.count += count;
    if (finding.sampleIds.size < MAX_SAMPLE_IDS) finding.sampleIds.add(id);
  }

  private inspectPoints(
    points: readonly unknown[], segmentId: RecordId | undefined, id: string, snapshot: boolean
  ) {
    for (const point of points) {
      const hasCoords = validCoords(point);
      const hasTimestamp = validTimestamp(point);
      if (!hasCoords) this.addIssue(snapshot ? 'invalidSnapshotPoint' : 'invalidTrackPoint', id);
      if (!hasTimestamp) this.addIssue(snapshot ? 'invalidSnapshotTimestamp' : 'invalidTrackTimestamp', id);
      if (snapshot || segmentId === undefined || !hasCoords || !hasTimestamp) continue;

      const fix = asRecord(point)!;
      const key = JSON.stringify([segmentId, fix.lat, fix.lon, fix.t]);
      if (this.duplicateFixKeys.has(key)) {
        this.addIssue('possibleDuplicateFixes', id);
      } else {
        if (this.duplicateFixKeys.size >= MAX_DUPLICATE_FIX_KEYS) {
          const oldest = this.duplicateFixKeys.keys().next().value;
          if (oldest !== undefined) this.duplicateFixKeys.delete(oldest);
        }
        this.duplicateFixKeys.set(key, true);
      }
    }
  }

  addTrip(trip: unknown) {
    this.counts.trips++;
    const id = asRecord(trip)?.id;
    if (isRecordId(id)) this.tripIds.add(id);
  }

  addSegment(segment: unknown, index: number) {
    this.counts.segments++;
    const row = asRecord(segment);
    const id = sampleId(segment, 'segments', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !this.tripIds.has(tripId)) this.addIssue('orphanSegment', id);
    if (isRecordId(row?.id)) {
      this.segmentsById.set(row.id, { tripId, index: row.index, pointCount: 0, sampleId: id });
    }
  }

  addTrackChunk(chunk: unknown, index: number) {
    this.counts.trackChunks++;
    const row = asRecord(chunk);
    const id = sampleId(chunk, 'trackChunks', index);
    const tripId = row?.tripId;
    const segmentId = row?.segmentId;
    const segment = isRecordId(segmentId) ? this.segmentsById.get(segmentId) : undefined;
    if (!isRecordId(tripId) || !this.tripIds.has(tripId) || !segment || segment.tripId !== tripId) {
      this.addIssue('orphanTrackChunk', id);
    }

    const points = row?.points;
    const seq = row?.seq;
    const validSeq = isSequence(seq);
    if (!Array.isArray(points) || !validSeq) this.addIssue('malformedTrackChunk', id);

    if (Array.isArray(points)) {
      this.counts.points += points.length;
      if (segment) segment.pointCount += points.length;
      this.inspectPoints(points, isRecordId(segmentId) ? segmentId : undefined, id, false);
    }

    if (segment && validSeq) {
      let seqs = this.chunkSeqsBySegment.get(segmentId);
      if (!seqs) {
        seqs = new Map();
        this.chunkSeqsBySegment.set(segmentId, seqs);
      }
      if (seqs.has(seq)) this.addIssue('duplicateChunkSeq', id);
      else seqs.set(seq, id);
    }
  }

  addTrackSnapshot(snapshot: unknown, index: number) {
    this.counts.trackSnapshots++;
    const row = asRecord(snapshot);
    const id = sampleId(snapshot, 'trackSnapshots', index);
    const tripId = row?.tripId;
    const segmentId = row?.segmentId;
    const segment = isRecordId(segmentId) ? this.segmentsById.get(segmentId) : undefined;
    if (!isRecordId(tripId) || !this.tripIds.has(tripId) || !segment || segment.tripId !== tripId) {
      this.addIssue('orphanTrackSnapshot', id);
    }

    const points = row?.points;
    const seq = row?.seq;
    const validSeq = isSequence(seq);
    const validSegmentIndex = isSequence(row?.segmentIndex);
    if (!Array.isArray(points) || !validSeq || !validSegmentIndex
      || (segment && row.segmentIndex !== segment.index)
      || !Number.isFinite(row?.createdAt)) this.addIssue('malformedTrackSnapshot', id);
    if (Array.isArray(points)) {
      this.counts.snapshotPoints += points.length;
      this.inspectPoints(points, undefined, id, true);
    }

    if (segment && validSeq) {
      let seqs = this.snapshotSeqsBySegment.get(segmentId);
      if (!seqs) {
        seqs = new Map();
        this.snapshotSeqsBySegment.set(segmentId, seqs);
      }
      if (seqs.has(seq)) this.addIssue('duplicateSnapshotSeq', id);
      else seqs.set(seq, id);
    }
  }

  addWaypoint(waypoint: unknown, index: number) {
    this.counts.waypoints++;
    const row = asRecord(waypoint);
    const id = sampleId(waypoint, 'waypoints', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !this.tripIds.has(tripId)) this.addIssue('orphanWaypoint', id);
    if (!validCoords(row)) this.addIssue('invalidWaypointCoords', id);
    if (Array.isArray(row?.mediaIds)) {
      for (const mediaId of row.mediaIds) if (isRecordId(mediaId)) this.referencedMediaIds.add(mediaId);
    }
  }

  addMedia(item: unknown, index: number) {
    this.counts.media++;
    const row = asRecord(item);
    const id = sampleId(item, 'media', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !this.tripIds.has(tripId)) this.addIssue('orphanMedia', id);

    const originalBytes = blobSize(row?.blob);
    const thumbBytes = blobSize(row?.thumb);
    if (originalBytes === null) this.addIssue('missingMediaBlob', id);
    this.counts.photoBytes += (originalBytes ?? 0) + (thumbBytes ?? 0);

    if (!isRecordId(row?.id) || !this.referencedMediaIds.has(row.id)) this.addIssue('unreferencedMedia', id);
  }

  finish(): StorageHealthResult {
    for (const segment of this.segmentsById.values()) {
      if (segment.pointCount === 0) this.addIssue('emptySegment', segment.sampleId);
    }

    for (const seqs of this.chunkSeqsBySegment.values()) {
      let previous = -1;
      const sorted = [...seqs.entries()].sort((a, b) => a[0] - b[0]);
      for (const [seq, id] of sorted) {
        const missing = seq - previous - 1;
        if (missing > 0) this.addIssue('missingChunkSeq', id, missing);
        previous = seq;
      }
    }

    for (const seqs of this.snapshotSeqsBySegment.values()) {
      let previous = -1;
      const sorted = [...seqs.entries()].sort((a, b) => a[0] - b[0]);
      for (const [seq, id] of sorted) {
        const missing = seq - previous - 1;
        if (missing > 0) this.addIssue('missingSnapshotSeq', id, missing);
        previous = seq;
      }
    }

    const issues: StorageHealthIssue[] = [];
    for (const key of Object.keys(ISSUE_DEFINITIONS) as IssueKey[]) {
      const finding = this.findings.get(key);
      if (!finding) continue;
      issues.push({
        type: ISSUE_DEFINITIONS[key].type,
        severity: ISSUE_DEFINITIONS[key].severity,
        count: finding.count,
        sampleIds: [...finding.sampleIds]
      });
    }

    const issueCount = issues.reduce((sum, issue) => sum + issue.count, 0);
    return {
      ok: !issues.some((issue) => issue.severity === 'error'),
      healthy: issueCount === 0,
      counts: this.counts,
      totals: { ...this.counts, issues: issueCount },
      issues
    };
  }
}

// Duplicate counts exclude the first occurrence; samples are capped and missing-sequence counts are arithmetic.
export function analyzeStorageHealth({
  trips = [], segments = [], trackChunks = [], trackSnapshots = [], waypoints = [], media = []
}: StorageHealthTables): StorageHealthResult {
  const analyzer = new StorageHealthAnalyzer();
  const tripRows = rows(trips);
  const segmentRows = rows(segments);
  const chunkRows = rows(trackChunks);
  const snapshotRows = rows(trackSnapshots);
  const waypointRows = rows(waypoints);
  const mediaRows = rows(media);
  for (const trip of tripRows) analyzer.addTrip(trip);
  for (let index = 0; index < segmentRows.length; index++) analyzer.addSegment(segmentRows[index], index);
  for (let index = 0; index < chunkRows.length; index++) analyzer.addTrackChunk(chunkRows[index], index);
  for (let index = 0; index < snapshotRows.length; index++) analyzer.addTrackSnapshot(snapshotRows[index], index);
  for (let index = 0; index < waypointRows.length; index++) analyzer.addWaypoint(waypointRows[index], index);
  for (let index = 0; index < mediaRows.length; index++) analyzer.addMedia(mediaRows[index], index);
  return analyzer.finish();
}

export type StorageHealthPhase = keyof StorageHealthTables;

export interface StorageHealthProgress {
  phase: StorageHealthPhase;
  processed: number;
  total?: number;
}

export interface InspectStorageHealthOptions {
  signal?: AbortSignal;
  onProgress?: (progress: StorageHealthProgress) => void;
}

const STORAGE_HEALTH_SCAN_BATCH_SIZE = 500;
const STORAGE_HEALTH_BLOB_CHUNK_BYTES = 64 * 1024;
const MAX_STORAGE_HEALTH_ATTEMPTS = 3;

type BlobRevisions = WeakMap<Blob, string>;
type ScanStorageOptions = InspectStorageHealthOptions & { yieldBetweenBatches?: boolean };

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Storage health scan aborted.', 'AbortError');
}

async function scanStorageTable(
  table: any,
  phase: StorageHealthPhase,
  consume: (value: unknown, index: number) => void,
  { signal, onProgress, yieldBetweenBatches = true }: ScanStorageOptions
) {
  let processed = 0;
  let lastPrimaryKey: unknown;
  let paginateByKey = true;
  let reported = -1;
  const report = () => {
    if (reported === processed) return;
    reported = processed;
    onProgress?.({ phase, processed });
  };

  throwIfAborted(signal);
  report();
  throwIfAborted(signal);

  while (true) {
    throwIfAborted(signal);
    let batchSize = 0;
    let reachedBatchEnd = false;
    let callbackError: unknown;
    const collection = processed === 0
      ? table
      : paginateByKey
        ? table.where(':id').above(lastPrimaryKey)
        : table.offset(processed);
    await collection.each((value: unknown, cursor: { primaryKey?: unknown; key?: unknown; stop: () => void }) => {
      try {
        throwIfAborted(signal);
        consume(value, processed);
        processed++;
        batchSize++;

        const primaryKey = cursor.primaryKey ?? asRecord(value)?.id;
        if (primaryKey === undefined) paginateByKey = false;
        else lastPrimaryKey = primaryKey;

        if (batchSize === STORAGE_HEALTH_SCAN_BATCH_SIZE) {
          reachedBatchEnd = true;
          cursor.stop();
        }
      } catch (error) {
        callbackError = error;
        cursor.stop();
      }
    });

    if (callbackError !== undefined) throw callbackError;
    throwIfAborted(signal);
    report();
    throwIfAborted(signal);
    if (!reachedBatchEnd) return;

    // A macrotask boundary keeps large scans from monopolizing the event loop.
    if (yieldBetweenBatches) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
  }
}

async function blobRevisionDigest(blob: Blob, signal?: AbortSignal): Promise<string> {
  let left = 0x811c9dc5;
  let right = 0xc2b2ae35;
  for (let offset = 0; offset < blob.size; offset += STORAGE_HEALTH_BLOB_CHUNK_BYTES) {
    throwIfAborted(signal);
    const end = Math.min(offset + STORAGE_HEALTH_BLOB_CHUNK_BYTES, blob.size);
    const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    throwIfAborted(signal);
    for (const byte of bytes) {
      left = Math.imul(left ^ byte, 0x01000193) >>> 0;
      right = Math.imul(right ^ byte, 0x85ebca6b) >>> 0;
    }
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

async function prepareBlobRevisions(value: unknown, revisions: BlobRevisions, signal?: AbortSignal) {
  throwIfAborted(signal);
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    if (!revisions.has(value)) revisions.set(value, await blobRevisionDigest(value, signal));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) await prepareBlobRevisions(item, revisions, signal);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      await prepareBlobRevisions((value as Record<string, unknown>)[key], revisions, signal);
    }
  }
}

async function scanStorageMediaTable(
  consume: (value: unknown, index: number) => void,
  blobRevisions: BlobRevisions,
  { signal, onProgress, yieldBetweenBatches = true }: ScanStorageOptions
) {
  let processed = 0;
  let hasScannedKeys = false;
  let lastPrimaryKey: unknown;
  let reported = -1;
  const report = () => {
    if (reported === processed) return;
    reported = processed;
    onProgress?.({ phase: 'media', processed });
  };

  throwIfAborted(signal);
  report();
  throwIfAborted(signal);

  while (true) {
    throwIfAborted(signal);
    const keys: unknown[] = [];
    let callbackFailed = false;
    let callbackError: unknown;
    const collection = !hasScannedKeys
      ? db.media
      : db.media.where(':id').above(lastPrimaryKey);
    await collection.each((_value: unknown, cursor: { primaryKey?: unknown; stop: () => void }) => {
      try {
        throwIfAborted(signal);
        if (cursor.primaryKey === undefined) throw new Error('Storage media primary key unavailable.');
        keys.push(cursor.primaryKey);
        if (keys.length === STORAGE_HEALTH_SCAN_BATCH_SIZE) cursor.stop();
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        cursor.stop();
      }
    });
    if (callbackFailed) throw callbackError;
    throwIfAborted(signal);
    hasScannedKeys = true;

    const processBatch = async () => {
      for (const key of keys) {
        throwIfAborted(signal);
        const value = await db.media.get(key);
        throwIfAborted(signal);
        if (value === undefined) continue;
        await Dexie.waitFor(async () => {
          await prepareBlobRevisions(value, blobRevisions, signal);
          throwIfAborted(signal);
          consume(value, processed);
          processed++;
        });
      }
    };
    if (Dexie.currentTransaction) await processBatch();
    else await db.transaction('r', db.media, processBatch);

    throwIfAborted(signal);
    report();
    throwIfAborted(signal);
    if (keys.length < STORAGE_HEALTH_SCAN_BATCH_SIZE) return;
    if (keys.length) lastPrimaryKey = keys[keys.length - 1];

    if (yieldBetweenBatches) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfAborted(signal);
  }
}

const STORAGE_HEALTH_TABLES = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media'] as const;

async function storageTableCounts(): Promise<number[]> {
  return Promise.all(STORAGE_HEALTH_TABLES.map((name) => db[name].count()));
}

function sameStorageCounts(left: number[], right: number[]) {
  return left.length === right.length && left.every((count, index) => count === right[index]);
}

type StorageRevision = [number, number];

function emptyStorageRevisions(): StorageRevision[] {
  return STORAGE_HEALTH_TABLES.map(() => [0x811c9dc5, 0xc2b2ae35]);
}

function revisionValue(value: unknown, blobRevisions?: BlobRevisions): unknown {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const digest = blobRevisions?.get(value);
    return {
      size: value.size,
      type: value.type,
      lastModified: typeof File !== 'undefined' && value instanceof File ? value.lastModified : 0,
      ...(digest === undefined ? {} : { digest })
    };
  }
  if (Array.isArray(value)) return value.map((item) => revisionValue(item, blobRevisions));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested !== undefined) out[key] = revisionValue(nested, blobRevisions);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function advanceRevision(state: StorageRevision, value: unknown, blobRevisions?: BlobRevisions): StorageRevision {
  const text = stableStringify(revisionValue(value, blobRevisions)) ?? 'undefined';
  let left = state[0];
  let right = state[1];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return [left, right];
}

function sameStorageRevisions(left: StorageRevision[], right: StorageRevision[]) {
  return left.length === right.length && left.every((revision, index) =>
    revision[0] === right[index][0] && revision[1] === right[index][1]
  );
}

// The final cursor pass and counts share one read transaction to prevent equal-count updates between checks.
export async function inspectStorageHealth(
  { signal, onProgress }: InspectStorageHealthOptions = {}
): Promise<StorageHealthResult> {
  throwIfAborted(signal);
  for (let attempt = 0; attempt < MAX_STORAGE_HEALTH_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    const before = await storageTableCounts();
    throwIfAborted(signal);
    const analyzer = new StorageHealthAnalyzer();
    const revisions = emptyStorageRevisions();
    await scanStorageTable(db.trips, 'trips', (trip) => {
      analyzer.addTrip(trip);
      revisions[0] = advanceRevision(revisions[0], trip);
    }, { signal, onProgress });
    await scanStorageTable(db.segments, 'segments', (segment, index) => {
      analyzer.addSegment(segment, index);
      revisions[1] = advanceRevision(revisions[1], segment);
    }, { signal, onProgress });
    await scanStorageTable(db.trackChunks, 'trackChunks', (chunk, index) => {
      analyzer.addTrackChunk(chunk, index);
      revisions[2] = advanceRevision(revisions[2], chunk);
    }, { signal, onProgress });
    await scanStorageTable(db.trackSnapshots, 'trackSnapshots', (snapshot, index) => {
      analyzer.addTrackSnapshot(snapshot, index);
      revisions[3] = advanceRevision(revisions[3], snapshot);
    }, { signal, onProgress });
    await scanStorageTable(db.waypoints, 'waypoints', (waypoint, index) => {
      analyzer.addWaypoint(waypoint, index);
      revisions[4] = advanceRevision(revisions[4], waypoint);
    }, { signal, onProgress });
    const mediaBlobRevisions: BlobRevisions = new WeakMap();
    await scanStorageMediaTable((item, index) => {
      analyzer.addMedia(item, index);
      revisions[5] = advanceRevision(revisions[5], item, mediaBlobRevisions);
    }, mediaBlobRevisions, { signal, onProgress });
    const after = await storageTableCounts();
    throwIfAborted(signal);
    if (sameStorageCounts(before, after)) {
      const verifiedResult = await db.transaction('r', STORAGE_HEALTH_TABLES.map((name) => db[name]), async () => {
        const verified = emptyStorageRevisions();
        await scanStorageTable(db.trips, 'trips', (trip) => { verified[0] = advanceRevision(verified[0], trip); }, { signal, yieldBetweenBatches: false });
        await scanStorageTable(db.segments, 'segments', (segment) => { verified[1] = advanceRevision(verified[1], segment); }, { signal, yieldBetweenBatches: false });
        await scanStorageTable(db.trackChunks, 'trackChunks', (chunk) => { verified[2] = advanceRevision(verified[2], chunk); }, { signal, yieldBetweenBatches: false });
        await scanStorageTable(db.trackSnapshots, 'trackSnapshots', (snapshot) => { verified[3] = advanceRevision(verified[3], snapshot); }, { signal, yieldBetweenBatches: false });
        await scanStorageTable(db.waypoints, 'waypoints', (waypoint) => { verified[4] = advanceRevision(verified[4], waypoint); }, { signal, yieldBetweenBatches: false });
        const verifiedMediaBlobRevisions: BlobRevisions = new WeakMap();
        await scanStorageMediaTable((item) => {
          verified[5] = advanceRevision(verified[5], item, verifiedMediaBlobRevisions);
        }, verifiedMediaBlobRevisions, { signal, yieldBetweenBatches: false });
        const finalCounts = await storageTableCounts();
        throwIfAborted(signal);
        return sameStorageCounts(before, finalCounts) && sameStorageRevisions(revisions, verified)
          ? analyzer.finish()
          : null;
      });
      throwIfAborted(signal);
      if (verifiedResult) return verifiedResult;
    }
    if (attempt + 1 < MAX_STORAGE_HEALTH_ATTEMPTS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  const error = new Error('Storage changed during the integrity scan.') as Error & { code: string };
  error.code = 'storage-health-concurrent';
  throw error;
}

function newCleanupToken() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function previewMediaCleanup(): Promise<MediaCleanupPreview> {
  const candidates = new Map<RecordId, number>();
  await db.transaction('r', [db.waypoints, db.media], async () => {
    const referenced = new Set<RecordId>();
    await db.waypoints.each((waypoint) => {
      const ids = asRecord(waypoint)?.mediaIds;
      if (Array.isArray(ids)) for (const id of ids) if (isRecordId(id)) referenced.add(id);
    });
    await db.media.each((item) => {
      const row = asRecord(item);
      const id = row?.id;
      if (!isRecordId(id) || referenced.has(id) || candidates.has(id)) return;
      candidates.set(id, (blobSize(row?.blob) ?? 0) + (blobSize(row?.thumb) ?? 0));
    });
  });

  const now = Date.now();
  for (const [token, record] of cleanupTokens) if (now - record.createdAt > CLEANUP_TOKEN_TTL) cleanupTokens.delete(token);
  while (cleanupTokens.size >= MAX_CLEANUP_TOKENS) cleanupTokens.delete(cleanupTokens.keys().next().value!);
  const ids = [...candidates.keys()];
  const bytes = ids.reduce<number>((sum, id) => sum + candidates.get(id)!, 0);
  const token = newCleanupToken();
  cleanupTokens.set(token, { ids, bytes, createdAt: now });
  return { token, count: ids.length, bytes, sampleIds: ids.slice(0, 5).map(String) };
}

async function withCleanupLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(CLEANUP_LOCK, task) : task();
}

export async function executeMediaCleanup(token: string): Promise<MediaCleanupResult> {
  const record = cleanupTokens.get(token);
  if (!record) throw new MediaCleanupTokenError();
  const result = await withCleanupLock(() => db.transaction('rw', [db.media, db.waypoints], async () => {
    const referenced = new Set<RecordId>();
    await db.waypoints.each((waypoint) => {
      const ids = asRecord(waypoint)?.mediaIds;
      if (Array.isArray(ids)) for (const id of ids) if (isRecordId(id)) referenced.add(id);
    });
    const ids: RecordId[] = [];
    let bytes = 0;
    for (const id of record.ids) {
      if (referenced.has(id)) continue;
      const row = asRecord(await db.media.get(id));
      if (!row) continue;
      ids.push(id);
      bytes += (blobSize(row.blob) ?? 0) + (blobSize(row.thumb) ?? 0);
    }
    if (ids.length) await db.media.bulkDelete(ids);
    return { deleted: ids.length, bytes, skipped: record.ids.length - ids.length };
  }));
  cleanupTokens.delete(token);
  return result;
}
