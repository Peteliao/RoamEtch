import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeStorageHealth,
  inspectStorageHealth,
  type StorageHealthIssueType,
  type StorageHealthResult,
  type StorageHealthTables
} from '../src/core/storageHealth';

const mocks = vi.hoisted(() => {
  const writeMethods = ['add', 'put', 'update', 'delete', 'clear', 'bulkDelete', 'modify'] as const;
  const makeTable = () => ({
    toArray: vi.fn(),
    add: vi.fn(),
    put: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    clear: vi.fn(),
    bulkDelete: vi.fn(),
    modify: vi.fn()
  });
  const tables = {
    trips: makeTable(),
    segments: makeTable(),
    trackChunks: makeTable(),
    trackSnapshots: makeTable(),
    waypoints: makeTable(),
    media: makeTable()
  };
  return { tables, db: { ...tables, transaction: vi.fn(), delete: vi.fn() }, writeMethods };
});

vi.mock('../src/core/store', () => ({ db: mocks.db }));

type Fixture = { [K in keyof StorageHealthTables]: any[] };
const tableNames = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media'] as const;

function point(lat = 30, lon = 120, t = 1000) {
  return { lat, lon, t };
}

function cleanTables(): Fixture {
  return {
    trips: [{ id: 'trip-1', name: 'Clean trip' }],
    segments: [{ id: 'segment-1', tripId: 'trip-1', index: 0 }],
    trackChunks: [
      {
        id: 'chunk-0', tripId: 'trip-1', segmentId: 'segment-1', seq: 0,
        points: [point(30, 120, 1000), point(30.1, 120.1, 2000)]
      },
      {
        id: 'chunk-1', tripId: 'trip-1', segmentId: 'segment-1', seq: 1,
        points: [point(30.2, 120.2, 3000)]
      }
    ],
    trackSnapshots: [{
      id: 'snapshot-0', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 0,
      createdAt: 1, points: [point(30, 120, 1000), point(30.1, 120.1, 2000), point(30.2, 120.2, 3000)]
    }],
    waypoints: [{
      id: 'waypoint-1', tripId: 'trip-1', lat: 31, lon: 121, time: 4000, mediaIds: ['media-1']
    }],
    media: [{
      id: 'media-1', tripId: 'trip-1', blob: new Blob(['photo']), thumb: new Blob(['thumb'])
    }]
  };
}

function emptyTables(): Fixture {
  return { trips: [], segments: [], trackChunks: [], trackSnapshots: [], waypoints: [], media: [] };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Blob)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function getIssue(result: StorageHealthResult, type: StorageHealthIssueType) {
  const issue = result.issues.find((candidate) => candidate.type === type);
  expect(issue, `Missing issue: ${type}`).toBeDefined();
  return issue!;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of Object.values(mocks.tables)) table.toArray.mockResolvedValue([]);
});

describe('analyzeStorageHealth', () => {
  it('reports clean totals without mutating the input', () => {
    const tables = deepFreeze(cleanTables());
    const result = analyzeStorageHealth(tables);
    const counts = {
      trips: 1,
      segments: 1,
      trackChunks: 2,
      trackSnapshots: 1,
      points: 3,
      snapshotPoints: 3,
      waypoints: 1,
      media: 1,
      photoBytes: 10
    };

    expect(result.counts).toEqual(counts);
    expect(result.totals).toEqual({ ...counts, issues: 0 });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.healthy).toBe(true);
  });

  it('accepts an empty database', () => {
    const result = analyzeStorageHealth(emptyTables());
    expect(result.totals).toEqual({
      trips: 0, segments: 0, trackChunks: 0, trackSnapshots: 0, points: 0,
      snapshotPoints: 0, waypoints: 0, media: 0, photoBytes: 0, issues: 0
    });
    expect(result.ok).toBe(true);
    expect(result.healthy).toBe(true);
  });

  it('flags chunks with missing trips, missing segments, or segment/trip mismatches', () => {
    const tables = cleanTables();
    tables.trips.push({ id: 'trip-2' });
    tables.segments.push({ id: 'segment-2', tripId: 'trip-2', index: 0 });
    tables.trackChunks.push(
      { id: 'chunk-missing-trip', tripId: 'missing-trip', segmentId: 'segment-1', seq: 2, points: [] },
      { id: 'chunk-missing-segment', tripId: 'trip-1', segmentId: 'missing-segment', seq: 0, points: [] },
      { id: 'chunk-mismatch', tripId: 'trip-1', segmentId: 'segment-2', seq: 0, points: [] }
    );

    expect(getIssue(analyzeStorageHealth(tables), 'orphan-track-chunk')).toEqual({
      type: 'orphan-track-chunk', severity: 'error', count: 3,
      sampleIds: ['chunk-missing-trip', 'chunk-missing-segment', 'chunk-mismatch']
    });
  });

  it('flags orphan segments', () => {
    const tables = cleanTables();
    tables.segments.push({ id: 'segment-orphan', tripId: 'missing-trip', index: 1 });
    expect(getIssue(analyzeStorageHealth(tables), 'orphan-segment')).toMatchObject({
      severity: 'error', count: 1, sampleIds: ['segment-orphan']
    });
  });

  it('reports non-array chunk points as malformed without counting them as points', () => {
    const tables = cleanTables();
    tables.trackChunks.push({
      id: 'chunk-malformed', tripId: 'trip-1', segmentId: 'segment-1', seq: 2, points: { length: 2 }
    });
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'malformed-track-chunk')).toEqual({
      type: 'malformed-track-chunk', severity: 'error', count: 1, sampleIds: ['chunk-malformed']
    });
    expect(result.counts.points).toBe(3);
  });

  it('reports invalid chunk sequence values as malformed and excludes them from gap checks', () => {
    const tables = cleanTables();
    tables.trackChunks.push(
      { id: 'chunk-negative', tripId: 'trip-1', segmentId: 'segment-1', seq: -1, points: [] },
      { id: 'chunk-fractional', tripId: 'trip-1', segmentId: 'segment-1', seq: 1.5, points: [] },
      { id: 'chunk-unsafe', tripId: 'trip-1', segmentId: 'segment-1', seq: Number.MAX_SAFE_INTEGER + 1, points: [] }
    );
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'malformed-track-chunk').count).toBe(3);
    expect(result.issues.some((issue) => issue.type === 'missing-chunk-seq')).toBe(false);
  });

  it('separates invalid track coordinates from invalid timestamps', () => {
    const tables = cleanTables();
    tables.trackChunks[0].points = [
      point(NaN, 120, 1000),
      point(Infinity, 120, 1000),
      point(91, 120, 1000),
      point(30, -181, 1000),
      point('30' as any, 120, 1000),
      point(30, 120, NaN),
      point(30, 120, Infinity),
      point(30, 120, '1000' as any),
      { lat: 30, lon: 120, t: undefined }
    ];
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'invalid-track-point')).toMatchObject({ severity: 'error', count: 5 });
    expect(getIssue(result, 'invalid-track-timestamp')).toMatchObject({ severity: 'warning', count: 4 });
    expect(result.counts.points).toBe(10);
  });

  it('also validates coordinates and timestamps inside snapshots', () => {
    const tables = cleanTables();
    tables.trackSnapshots[0].points = [point(91, 120, 1000), point(30, 120, NaN)];
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'invalid-snapshot-point').count).toBe(1);
    expect(getIssue(result, 'invalid-snapshot-timestamp').count).toBe(1);
    expect(result.issues.some((issue) => issue.type === 'malformed-track-snapshot')).toBe(false);
    expect(result.counts.snapshotPoints).toBe(2);
  });

  it('reports duplicate chunk sequences and missing sequence values separately', () => {
    const tables = cleanTables();
    tables.trackChunks.push(
      { id: 'chunk-duplicate', tripId: 'trip-1', segmentId: 'segment-1', seq: 0, points: [point(40, 100, 4000)] },
      { id: 'chunk-after-gap', tripId: 'trip-1', segmentId: 'segment-1', seq: 3, points: [point(41, 101, 5000)] }
    );
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'duplicate-chunk-seq')).toEqual({
      type: 'duplicate-chunk-seq', severity: 'error', count: 1, sampleIds: ['chunk-duplicate']
    });
    expect(getIssue(result, 'missing-chunk-seq')).toEqual({
      type: 'missing-chunk-seq', severity: 'error', count: 1, sampleIds: ['chunk-after-gap']
    });
  });

  it('counts large leading sequence gaps arithmetically', () => {
    const tables = cleanTables();
    tables.segments.push({ id: 'segment-gap', tripId: 'trip-1', index: 1 });
    tables.trackChunks.push({
      id: 'chunk-leading-gap', tripId: 'trip-1', segmentId: 'segment-gap', seq: 1_000_000_000, points: []
    });
    expect(getIssue(analyzeStorageHealth(tables), 'missing-chunk-seq')).toMatchObject({
      count: 1_000_000_000, sampleIds: ['chunk-leading-gap']
    });
  });

  it('reports segments with no chunks or only empty chunks as informational', () => {
    const tables = cleanTables();
    tables.segments.push(
      { id: 'segment-empty', tripId: 'trip-1', index: 1 },
      { id: 'segment-empty-chunk', tripId: 'trip-1', index: 2 }
    );
    tables.trackChunks.push({
      id: 'chunk-empty', tripId: 'trip-1', segmentId: 'segment-empty-chunk', seq: 0, points: []
    });
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'empty-segment')).toEqual({
      type: 'empty-segment', severity: 'info', count: 2,
      sampleIds: ['segment-empty', 'segment-empty-chunk']
    });
    expect(result.ok).toBe(true);
    expect(result.healthy).toBe(false);
  });

  it('flags snapshots with missing trips, missing segments, or trip mismatches', () => {
    const tables = cleanTables();
    tables.trips.push({ id: 'trip-2' });
    tables.segments.push({ id: 'segment-2', tripId: 'trip-2', index: 0 });
    tables.trackSnapshots.push(
      { id: 'snapshot-missing-trip', tripId: 'missing-trip', segmentId: 'segment-1', segmentIndex: 0, seq: 1, createdAt: 1, points: [] },
      { id: 'snapshot-missing-segment', tripId: 'trip-1', segmentId: 'missing-segment', segmentIndex: 0, seq: 0, createdAt: 1, points: [] },
      { id: 'snapshot-mismatch', tripId: 'trip-1', segmentId: 'segment-2', segmentIndex: 0, seq: 0, createdAt: 1, points: [] }
    );
    expect(getIssue(analyzeStorageHealth(tables), 'orphan-track-snapshot')).toMatchObject({
      severity: 'error', count: 3,
      sampleIds: ['snapshot-missing-trip', 'snapshot-missing-segment', 'snapshot-mismatch']
    });
  });

  it('reports malformed snapshots without throwing', () => {
    const tables = cleanTables();
    tables.trackSnapshots.push({
      id: 'snapshot-malformed', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 1, createdAt: 1, points: null
    });
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'malformed-track-snapshot')).toEqual({
      type: 'malformed-track-snapshot', severity: 'error', count: 1, sampleIds: ['snapshot-malformed']
    });
    expect(result.counts.snapshotPoints).toBe(3);
  });

  it('flags missing or mismatched snapshot indexes and invalid creation times', () => {
    const tables = cleanTables();
    tables.trackSnapshots = [
      { id: 'snapshot-wrong-index', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 1, seq: 0, createdAt: 1, points: [] },
      { id: 'snapshot-missing-index', tripId: 'trip-1', segmentId: 'segment-1', seq: 0, createdAt: 1, points: [] },
      { id: 'snapshot-bad-time', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 0, createdAt: NaN, points: [] }
    ];

    expect(getIssue(analyzeStorageHealth(tables), 'malformed-track-snapshot')).toMatchObject({
      severity: 'error', count: 3
    });
  });

  it('reports duplicate snapshot sequences and missing values separately', () => {
    const tables = cleanTables();
    tables.trackSnapshots.push(
      { id: 'snapshot-duplicate', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 0, createdAt: 1, points: [] },
      { id: 'snapshot-after-gap', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 2, createdAt: 1, points: [] }
    );
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'duplicate-snapshot-seq')).toEqual({
      type: 'duplicate-snapshot-seq', severity: 'error', count: 1, sampleIds: ['snapshot-duplicate']
    });
    expect(getIssue(result, 'missing-snapshot-seq')).toEqual({
      type: 'missing-snapshot-seq', severity: 'error', count: 1, sampleIds: ['snapshot-after-gap']
    });
    expect(result.ok).toBe(false);
  });

  it('counts large leading snapshot gaps arithmetically and excludes invalid sequences', () => {
    const tables = cleanTables();
    tables.trackSnapshots = [
      { id: 'snapshot-leading-gap', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 1_000_000_000, createdAt: 1, points: [] },
      { id: 'snapshot-invalid', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: -1, createdAt: 1, points: [] }
    ];
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'missing-snapshot-seq')).toMatchObject({
      count: 1_000_000_000, sampleIds: ['snapshot-leading-gap']
    });
    expect(getIssue(result, 'malformed-track-snapshot').count).toBe(1);
  });

  it('scopes duplicate snapshot sequences to their segment', () => {
    const tables = cleanTables();
    tables.trackSnapshots.push({
      id: 'snapshot-duplicate', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 0, createdAt: 1, points: []
    });
    tables.segments.push({ id: 'segment-2', tripId: 'trip-1', index: 1 });
    tables.trackSnapshots.push({
      id: 'snapshot-other-segment', tripId: 'trip-1', segmentId: 'segment-2', segmentIndex: 1, seq: 0, createdAt: 1, points: []
    });
    expect(getIssue(analyzeStorageHealth(tables), 'duplicate-snapshot-seq')).toEqual({
      type: 'duplicate-snapshot-seq', severity: 'error', count: 1, sampleIds: ['snapshot-duplicate']
    });
  });

  it('flags orphan waypoints and media', () => {
    const tables = cleanTables();
    tables.waypoints.push({
      id: 'waypoint-orphan', tripId: 'missing-trip', lat: 30, lon: 120, mediaIds: []
    });
    tables.media.push({ id: 'media-orphan', tripId: 'missing-trip', blob: new Blob(['orphan']) });
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'orphan-waypoint')).toMatchObject({ count: 1, sampleIds: ['waypoint-orphan'] });
    expect(getIssue(result, 'orphan-media')).toMatchObject({ count: 1, sampleIds: ['media-orphan'] });
  });

  it('flags nonfinite and out-of-range waypoint coordinates', () => {
    const tables = cleanTables();
    tables.waypoints.push(
      { id: 'waypoint-nan', tripId: 'trip-1', lat: NaN, lon: 120, mediaIds: [] },
      { id: 'waypoint-infinite', tripId: 'trip-1', lat: 30, lon: Infinity, mediaIds: [] },
      { id: 'waypoint-lat', tripId: 'trip-1', lat: -91, lon: 120, mediaIds: [] },
      { id: 'waypoint-lon', tripId: 'trip-1', lat: 30, lon: 181, mediaIds: [] }
    );
    expect(getIssue(analyzeStorageHealth(tables), 'invalid-waypoint-coords')).toMatchObject({
      severity: 'error', count: 4
    });
  });

  it('detects non-adjacent possible duplicate fixes only within the same segment', () => {
    const tables = cleanTables();
    const fix = point(30, 120, 1000);
    tables.trackChunks[0].points = [fix, point(30.1, 120.1, 2000), { ...fix }];
    tables.trackChunks[1].points = [{ ...fix }, point(30, 120, 1001)];
    tables.segments.push({ id: 'segment-2', tripId: 'trip-1', index: 1 });
    tables.trackChunks.push({
      id: 'chunk-other-segment', tripId: 'trip-1', segmentId: 'segment-2', seq: 0, points: [{ ...fix }]
    });
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'possible-duplicate-fixes')).toEqual({
      type: 'possible-duplicate-fixes', severity: 'info', count: 2,
      sampleIds: ['chunk-0', 'chunk-1']
    });
    expect(result.ok).toBe(true);
    expect(result.healthy).toBe(false);
  });

  it('bounds duplicate-fix fingerprint memory and issue samples', () => {
    const tables = cleanTables();
    tables.trackChunks[0].points = Array.from({ length: 50_001 }, (_, index) => point(0, 0, index));
    tables.trackChunks[1].points = [point(0, 0, 50_000)];
    for (let index = 0; index < 24; index++) {
      tables.trackChunks.push({
        id: `chunk-duplicate-${index}`, tripId: 'trip-1', segmentId: 'segment-1', seq: index + 2,
        points: [point(0, 0, 49_000 - index)]
      });
    }
    // The first fingerprint has been evicted, so this repeat is not retained as a duplicate.
    tables.trackChunks.push({
      id: 'chunk-evicted', tripId: 'trip-1', segmentId: 'segment-1', seq: 26, points: [point(0, 0, 0)]
    });

    const issue = getIssue(analyzeStorageHealth(tables), 'possible-duplicate-fixes');
    expect(issue.count).toBe(25);
    expect(issue.sampleIds).toHaveLength(20);
    expect(new Set(issue.sampleIds).size).toBe(20);
  });

  it('does not treat a missing thumbnail as a missing original blob', () => {
    const tables = cleanTables();
    tables.media[0].thumb = undefined;
    const result = analyzeStorageHealth(tables);
    expect(result.counts.photoBytes).toBe(5);
    expect(result.issues.some((issue) => issue.type === 'missing-media-blob')).toBe(false);
    expect(result.healthy).toBe(true);
  });

  it('accepts a zero-byte original blob', () => {
    const tables = cleanTables();
    tables.media[0].blob = new Blob([]);
    tables.media[0].thumb = undefined;
    const result = analyzeStorageHealth(tables);
    expect(result.counts.photoBytes).toBe(0);
    expect(result.issues.some((issue) => issue.type === 'missing-media-blob')).toBe(false);
  });

  it('reports missing originals and unreferenced media independently', () => {
    const tables = cleanTables();
    tables.waypoints[0].mediaIds.push('media-thumb-only');
    tables.media.push(
      { id: 'media-thumb-only', tripId: 'trip-1', blob: null, thumb: new Blob(['thumb']) },
      { id: 'media-unused', tripId: 'trip-1', blob: new Blob(['unused']) },
      { id: 'media-unused-missing', tripId: 'trip-1', blob: undefined }
    );
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'missing-media-blob')).toEqual({
      type: 'missing-media-blob', severity: 'error', count: 2,
      sampleIds: ['media-thumb-only', 'media-unused-missing']
    });
    expect(getIssue(result, 'unreferenced-media')).toEqual({
      type: 'unreferenced-media', severity: 'warning', count: 2,
      sampleIds: ['media-unused', 'media-unused-missing']
    });
    expect(result.counts.photoBytes).toBe(21);
    expect(result.ok).toBe(false);
  });

  it('uses bounded fallback IDs for malformed rows', () => {
    const tables = cleanTables();
    tables.trackChunks.push(null);
    const result = analyzeStorageHealth(tables);
    expect(getIssue(result, 'malformed-track-chunk').sampleIds).toContain('trackChunks[2]');
    expect(getIssue(result, 'orphan-track-chunk').sampleIds).toContain('trackChunks[2]');
  });
});

describe('inspectStorageHealth', () => {
  it('reads all six tables, returns the pure result, and performs no writes', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mocks.tables[name].toArray.mockResolvedValue(tables[name]);

    const result = await inspectStorageHealth();

    expect(result).toEqual(analyzeStorageHealth(tables));
    for (const name of tableNames) {
      const table = mocks.tables[name];
      expect(table.toArray).toHaveBeenCalledTimes(1);
      for (const method of mocks.writeMethods) expect(table[method]).not.toHaveBeenCalled();
    }
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.db.delete).not.toHaveBeenCalled();
  });

  it('propagates database read failures without attempting repairs', async () => {
    mocks.tables.media.toArray.mockRejectedValue(new Error('read failed'));
    await expect(inspectStorageHealth()).rejects.toThrow('read failed');
    for (const table of Object.values(mocks.tables)) {
      for (const method of mocks.writeMethods) expect(table[method]).not.toHaveBeenCalled();
    }
  });
});
