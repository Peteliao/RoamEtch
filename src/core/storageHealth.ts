import { db } from './store';

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

// Duplicate counts exclude the first occurrence; samples are capped and missing-sequence counts are arithmetic.
export function analyzeStorageHealth({
  trips = [], segments = [], trackChunks = [], trackSnapshots = [], waypoints = [], media = []
}: StorageHealthTables): StorageHealthResult {
  const tripRows = rows(trips);
  const segmentRows = rows(segments);
  const chunkRows = rows(trackChunks);
  const snapshotRows = rows(trackSnapshots);
  const waypointRows = rows(waypoints);
  const mediaRows = rows(media);

  const counts: StorageHealthCounts = {
    trips: tripRows.length,
    segments: segmentRows.length,
    trackChunks: chunkRows.length,
    trackSnapshots: snapshotRows.length,
    points: 0,
    snapshotPoints: 0,
    waypoints: waypointRows.length,
    media: mediaRows.length,
    photoBytes: 0
  };

  const findings = new Map<IssueKey, { count: number; sampleIds: Set<string> }>();
  const addIssue = (key: IssueKey, id: string, count = 1) => {
    let finding = findings.get(key);
    if (!finding) {
      finding = { count: 0, sampleIds: new Set() };
      findings.set(key, finding);
    }
    finding.count += count;
    if (finding.sampleIds.size < MAX_SAMPLE_IDS) finding.sampleIds.add(id);
  };

  const duplicateFixKeys = new Map<string, true>();
  const inspectPoints = (
    points: readonly unknown[], segmentId: RecordId | undefined, id: string, snapshot: boolean
  ) => {
    for (const point of points) {
      const hasCoords = validCoords(point);
      const hasTimestamp = validTimestamp(point);
      if (!hasCoords) addIssue(snapshot ? 'invalidSnapshotPoint' : 'invalidTrackPoint', id);
      if (!hasTimestamp) addIssue(snapshot ? 'invalidSnapshotTimestamp' : 'invalidTrackTimestamp', id);
      if (snapshot || segmentId === undefined || !hasCoords || !hasTimestamp) continue;

      const fix = asRecord(point)!;
      const key = JSON.stringify([segmentId, fix.lat, fix.lon, fix.t]);
      if (duplicateFixKeys.has(key)) {
        addIssue('possibleDuplicateFixes', id);
      } else {
        if (duplicateFixKeys.size >= MAX_DUPLICATE_FIX_KEYS) {
          const oldest = duplicateFixKeys.keys().next().value;
          if (oldest !== undefined) duplicateFixKeys.delete(oldest);
        }
        duplicateFixKeys.set(key, true);
      }
    }
  };

  const tripIds = new Set<RecordId>();
  for (const trip of tripRows) {
    const id = asRecord(trip)?.id;
    if (isRecordId(id)) tripIds.add(id);
  }

  const segmentsById = new Map<RecordId, SegmentInfo>();
  for (let index = 0; index < segmentRows.length; index++) {
    const segment = segmentRows[index];
    const row = asRecord(segment);
    const id = sampleId(segment, 'segments', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !tripIds.has(tripId)) addIssue('orphanSegment', id);
    if (isRecordId(row?.id)) {
      segmentsById.set(row.id, { tripId, index: row.index, pointCount: 0, sampleId: id });
    }
  }

  const chunkSeqsBySegment = new Map<RecordId, Map<number, string>>();
  for (let index = 0; index < chunkRows.length; index++) {
    const chunk = chunkRows[index];
    const row = asRecord(chunk);
    const id = sampleId(chunk, 'trackChunks', index);
    const tripId = row?.tripId;
    const segmentId = row?.segmentId;
    const segment = isRecordId(segmentId) ? segmentsById.get(segmentId) : undefined;
    if (!isRecordId(tripId) || !tripIds.has(tripId) || !segment || segment.tripId !== tripId) {
      addIssue('orphanTrackChunk', id);
    }

    const points = row?.points;
    const seq = row?.seq;
    const validSeq = isSequence(seq);
    if (!Array.isArray(points) || !validSeq) addIssue('malformedTrackChunk', id);

    if (Array.isArray(points)) {
      counts.points += points.length;
      if (segment) segment.pointCount += points.length;
      inspectPoints(points, isRecordId(segmentId) ? segmentId : undefined, id, false);
    }

    if (segment && validSeq) {
      let seqs = chunkSeqsBySegment.get(segmentId);
      if (!seqs) {
        seqs = new Map();
        chunkSeqsBySegment.set(segmentId, seqs);
      }
      if (seqs.has(seq)) addIssue('duplicateChunkSeq', id);
      else seqs.set(seq, id);
    }
  }

  for (const segment of segmentsById.values()) {
    if (segment.pointCount === 0) addIssue('emptySegment', segment.sampleId);
  }

  for (const seqs of chunkSeqsBySegment.values()) {
    let previous = -1;
    const sorted = [...seqs.entries()].sort((a, b) => a[0] - b[0]);
    for (const [seq, id] of sorted) {
      const missing = seq - previous - 1;
      if (missing > 0) addIssue('missingChunkSeq', id, missing);
      previous = seq;
    }
  }

  const snapshotSeqsBySegment = new Map<RecordId, Map<number, string>>();
  for (let index = 0; index < snapshotRows.length; index++) {
    const snapshot = snapshotRows[index];
    const row = asRecord(snapshot);
    const id = sampleId(snapshot, 'trackSnapshots', index);
    const tripId = row?.tripId;
    const segmentId = row?.segmentId;
    const segment = isRecordId(segmentId) ? segmentsById.get(segmentId) : undefined;
    if (!isRecordId(tripId) || !tripIds.has(tripId) || !segment || segment.tripId !== tripId) {
      addIssue('orphanTrackSnapshot', id);
    }

    const points = row?.points;
    const seq = row?.seq;
    const validSeq = isSequence(seq);
    const validSegmentIndex = isSequence(row?.segmentIndex);
    if (!Array.isArray(points) || !validSeq || !validSegmentIndex
      || (segment && row.segmentIndex !== segment.index)
      || !Number.isFinite(row?.createdAt)) addIssue('malformedTrackSnapshot', id);
    if (Array.isArray(points)) {
      counts.snapshotPoints += points.length;
      inspectPoints(points, undefined, id, true);
    }

    if (segment && validSeq) {
      let seqs = snapshotSeqsBySegment.get(segmentId);
      if (!seqs) {
        seqs = new Map();
        snapshotSeqsBySegment.set(segmentId, seqs);
      }
      if (seqs.has(seq)) addIssue('duplicateSnapshotSeq', id);
      else seqs.set(seq, id);
    }
  }

  for (const seqs of snapshotSeqsBySegment.values()) {
    let previous = -1;
    const sorted = [...seqs.entries()].sort((a, b) => a[0] - b[0]);
    for (const [seq, id] of sorted) {
      const missing = seq - previous - 1;
      if (missing > 0) addIssue('missingSnapshotSeq', id, missing);
      previous = seq;
    }
  }

  const referencedMediaIds = new Set<RecordId>();
  for (let index = 0; index < waypointRows.length; index++) {
    const waypoint = waypointRows[index];
    const row = asRecord(waypoint);
    const id = sampleId(waypoint, 'waypoints', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !tripIds.has(tripId)) addIssue('orphanWaypoint', id);
    if (!validCoords(row)) addIssue('invalidWaypointCoords', id);
    if (Array.isArray(row?.mediaIds)) {
      for (const mediaId of row.mediaIds) if (isRecordId(mediaId)) referencedMediaIds.add(mediaId);
    }
  }

  for (let index = 0; index < mediaRows.length; index++) {
    const item = mediaRows[index];
    const row = asRecord(item);
    const id = sampleId(item, 'media', index);
    const tripId = row?.tripId;
    if (!isRecordId(tripId) || !tripIds.has(tripId)) addIssue('orphanMedia', id);

    const originalBytes = blobSize(row?.blob);
    const thumbBytes = blobSize(row?.thumb);
    if (originalBytes === null) addIssue('missingMediaBlob', id);
    counts.photoBytes += (originalBytes ?? 0) + (thumbBytes ?? 0);

    if (!isRecordId(row?.id) || !referencedMediaIds.has(row.id)) addIssue('unreferencedMedia', id);
  }

  const issues: StorageHealthIssue[] = [];
  for (const key of Object.keys(ISSUE_DEFINITIONS) as IssueKey[]) {
    const finding = findings.get(key);
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
    counts,
    totals: { ...counts, issues: issueCount },
    issues
  };
}

// Read all six trip tables and analyze them without performing any writes.
export async function inspectStorageHealth(): Promise<StorageHealthResult> {
  const [trips, segments, trackChunks, trackSnapshots, waypoints, media] = await Promise.all([
    db.trips.toArray(),
    db.segments.toArray(),
    db.trackChunks.toArray(),
    db.trackSnapshots.toArray(),
    db.waypoints.toArray(),
    db.media.toArray()
  ]);
  return analyzeStorageHealth({ trips, segments, trackChunks, trackSnapshots, waypoints, media });
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
