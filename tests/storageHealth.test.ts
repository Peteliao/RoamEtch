import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  analyzeStorageHealth,
  inspectStorageHealth,
  type StorageHealthIssueType,
  type StorageHealthProgress,
  type StorageHealthResult,
  type StorageHealthTables
} from '../src/core/storageHealth';

const mocks = vi.hoisted(() => {
  const writeMethods = ['add', 'put', 'update', 'delete', 'clear', 'bulkDelete', 'modify'] as const;
  const makeTable = () => ({
    toArray: vi.fn(),
    count: vi.fn(),
    each: vi.fn(),
    get: vi.fn(),
    where: vi.fn(),
    offset: vi.fn(),
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

type ScanCursor = {
  primaryKey?: unknown;
  key?: unknown;
  continue: () => void;
  stop: () => void;
  fail: (error: unknown) => void;
};

type ScanCallback = (value: unknown, cursor: ScanCursor, advance?: (next: () => void) => void) => unknown;

function mockTableRows(table: any, getRows: () => Iterable<unknown>) {
  const scans: Mock[] = [];
  const scan = async (callback: ScanCallback, after: unknown, useAfter: boolean, offset = 0) => {
    let skipped = 0;
    for (const value of getRows()) {
      const primaryKey = (value as any)?.id;
      if (useAfter && (primaryKey as any) <= (after as any)) continue;
      if (skipped++ < offset) continue;
      let stopped = false;
      await new Promise<void>((resolve, reject) => {
        let paused = false;
        const cursor: ScanCursor = {
          primaryKey,
          key: primaryKey,
          continue: resolve,
          stop: () => { stopped = true; resolve(); },
          fail: reject
        };
        try {
          callback(value, cursor, () => { paused = true; });
          if (!paused) resolve();
        } catch {
          // Dexie cursor callbacks swallow synchronous exceptions.
          resolve();
        }
      });
      if (stopped) return;
    }
  };
  const collection = (after: unknown, useAfter: boolean, offset?: number) => {
    const each = vi.fn((callback: ScanCallback) => scan(callback, after, useAfter, offset));
    scans.push(each);
    return { each };
  };

  scans.push(table.each);
  table.each.mockImplementation((callback: ScanCallback) => scan(callback, undefined, false));
  table.get.mockImplementation(async (key: unknown) => {
    const rows = getRows();
    if (Array.isArray(rows)) return rows.find((value) => (value as any)?.id === key);
    for (const value of rows) if ((value as any)?.id === key) return value;
    return undefined;
  });
  table.where.mockImplementation(() => ({
    above: vi.fn((key: unknown) => collection(key, true))
  }));
  table.offset.mockImplementation((offset: number) => collection(undefined, false, offset));
  table.count.mockImplementation(async () => Array.from(getRows()).length);
  return { scans };
}

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

function expectNoWrites() {
  for (const table of Object.values(mocks.tables)) {
    for (const method of mocks.writeMethods) expect(table[method]).not.toHaveBeenCalled();
  }
  for (const [mode] of mocks.db.transaction.mock.calls) expect(mode).toBe('r');
  expect(mocks.db.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.transaction.mockReset().mockImplementation(async (_mode, _tables, run) => run());
  for (const table of Object.values(mocks.tables)) {
    table.toArray.mockReset().mockResolvedValue([]);
    table.count.mockReset().mockResolvedValue(0);
    table.each.mockReset().mockResolvedValue(undefined);
    table.get.mockReset().mockResolvedValue(undefined);
    table.where.mockReset();
    table.offset.mockReset();
  }
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
  it('reads all six tables and verifies revisions inside one read-only transaction', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);

    const result = await inspectStorageHealth();

    expect(result).toEqual(analyzeStorageHealth(tables));
    for (const name of tableNames) {
      const table = mocks.tables[name];
      expect(table.toArray).not.toHaveBeenCalled();
      expect(table.each).toHaveBeenCalledTimes(2);
    }
    expect(mocks.db.transaction).toHaveBeenCalledWith('r', tableNames.map((name) => mocks.tables[name]), expect.any(Function));
    expectNoWrites();
  });

  it('retries when concurrent inserts change table counts during a scan', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const scan = mocks.tables.trackChunks.each.getMockImplementation()!;
    let inserted = false;
    mocks.tables.trackChunks.each.mockImplementation(async (callback: ScanCallback) => {
      await scan(callback);
      if (!inserted) {
        inserted = true;
        tables.trackChunks.push({
          id: 'chunk-2', tripId: 'trip-1', segmentId: 'segment-1', seq: 2,
          points: [point(30.3, 120.3, 4000)]
        });
      }
    });

    const result = await inspectStorageHealth();

    expect(result).toEqual(analyzeStorageHealth(tables));
    expect(result.healthy).toBe(true);
    expect(mocks.tables.trackChunks.each).toHaveBeenCalledTimes(3);
    expectNoWrites();
  });

  it('retries when an in-place update leaves table counts unchanged', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const scan = mocks.tables.trackChunks.each.getMockImplementation()!;
    let updated = false;
    mocks.tables.trackChunks.each.mockImplementation(async (callback: ScanCallback) => {
      await scan(callback);
      if (!updated) {
        updated = true;
        tables.trackChunks[0].points[0].lat = 30.01;
      }
    });

    const result = await inspectStorageHealth();

    expect(result).toEqual(analyzeStorageHealth(tables));
    expect(result.healthy).toBe(true);
    expect(mocks.tables.trackChunks.each).toHaveBeenCalledTimes(4);
    expectNoWrites();
  });

  it('retries when a same-size media Blob changes bytes without changing table counts', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const count = mocks.tables.media.count.getMockImplementation()!;
    let countCalls = 0;
    mocks.tables.media.count.mockImplementation(async () => {
      const result = await count();
      countCalls++;
      if (countCalls === 2) tables.media[0].blob = new Blob(['other']);
      return result;
    });

    const result = await inspectStorageHealth();

    expect(tables.media[0].blob.size).toBe(5);
    expect(result).toEqual(analyzeStorageHealth(tables));
    expect(result.healthy).toBe(true);
    expect(countCalls).toBe(6);
    expect(mocks.tables.media.each).toHaveBeenCalledTimes(4);
    expectNoWrites();
  });

  it('fails instead of reporting corruption when writes continue throughout every attempt', async () => {
    const tables = cleanTables();
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const scan = mocks.tables.trackChunks.each.getMockImplementation()!;
    mocks.tables.trackChunks.each.mockImplementation(async (callback: ScanCallback) => {
      await scan(callback);
      const seq = tables.trackChunks.length;
      tables.trackChunks.push({
        id: `chunk-${seq}`, tripId: 'trip-1', segmentId: 'segment-1', seq,
        points: [point(30, 120, seq + 1)]
      });
    });

    await expect(inspectStorageHealth()).rejects.toMatchObject({ code: 'storage-health-concurrent' });
    expect(mocks.tables.trackChunks.each).toHaveBeenCalledTimes(3);
    expectNoWrites();
  });

  it('matches pure analysis for malformed, duplicate, missing, and orphaned rows', async () => {
    const tables = cleanTables();
    tables.segments.push({ id: 'segment-empty', tripId: 'trip-1', index: 1 });
    tables.trackChunks.push(
      { id: 'chunk-gap', tripId: 'trip-1', segmentId: 'segment-1', seq: 4, points: [point(NaN, 120, 1)] },
      { id: 'chunk-duplicate', tripId: 'trip-1', segmentId: 'segment-1', seq: 0, points: [point(30, 120, 1000)] },
      null
    );
    tables.trackSnapshots.push(
      { id: 'snapshot-gap', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 2, createdAt: 1, points: null },
      { id: 'snapshot-duplicate', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, seq: 0, createdAt: 1, points: [point(91, 120, NaN)] }
    );
    tables.waypoints.push({ id: 'waypoint-orphan', tripId: 'missing', lat: 91, lon: 120, mediaIds: ['media-missing'] });
    tables.media.push({ id: 'media-unused', tripId: 'trip-1', blob: null });
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);

    expect(await inspectStorageHealth()).toEqual(analyzeStorageHealth(tables));
    expectNoWrites();
  });

  it('reports bounded progress, resumes cursors by primary key, and yields to the event loop', async () => {
    const tables = cleanTables();
    tables.trackChunks = Array.from({ length: 1001 }, (_, index) => ({
      id: `chunk-${String(index).padStart(4, '0')}`,
      tripId: 'trip-1', segmentId: 'segment-1', seq: index,
      points: [point(30, 120, index + 1)]
    }));
    const scans = new Map<string, Mock[]>();
    for (const name of tableNames) scans.set(name, mockTableRows(mocks.tables[name], () => tables[name]).scans);

    const progress: StorageHealthProgress[] = [];
    let eventLoopTurned = false;
    const eventLoopProbe = setTimeout(() => { eventLoopTurned = true; }, 0);
    const result = await inspectStorageHealth({ onProgress: (update) => progress.push(update) });
    clearTimeout(eventLoopProbe);

    expect(result).toEqual(analyzeStorageHealth(tables));
    expect(eventLoopTurned).toBe(true);
    expect([...new Set(progress.map((update) => update.phase))]).toEqual(tableNames);
    for (const name of tableNames) {
      const updates = progress.filter((update) => update.phase === name);
      expect(updates[0]).toEqual({ phase: name, processed: 0 });
      expect(updates.at(-1)).toEqual({ phase: name, processed: tables[name].length });
      for (let index = 1; index < updates.length; index++) {
        expect(updates[index].processed).toBeGreaterThanOrEqual(updates[index - 1].processed);
      }
    }
    const chunkProgress = progress.filter((update) => update.phase === 'trackChunks');
    expect(chunkProgress).toContainEqual({ phase: 'trackChunks', processed: 500 });
    expect(chunkProgress).toContainEqual({ phase: 'trackChunks', processed: 1000 });
    expect(scans.get('trackChunks')).toHaveLength(5);
    expect(mocks.tables.trackChunks.where).toHaveBeenCalledTimes(4);
    expect(mocks.tables.trackChunks.where).toHaveBeenCalledWith(':id');
    for (const table of Object.values(mocks.tables)) expect(table.toArray).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('does not start reading when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before scan');
    controller.abort(reason);

    await expect(inspectStorageHealth({ signal: controller.signal })).rejects.toBe(reason);
    for (const table of Object.values(mocks.tables)) expect(table.each).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('cancels at a batch boundary without reading later tables', async () => {
    const tables = cleanTables();
    tables.trackChunks = Array.from({ length: 2000 }, (_, index) => ({
      id: `chunk-${String(index).padStart(4, '0')}`,
      tripId: 'trip-1', segmentId: 'segment-1', seq: index, points: []
    }));
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const controller = new AbortController();
    const reason = new Error('cancelled during scan');
    let processedAtCancellation = 0;

    await expect(inspectStorageHealth({
      signal: controller.signal,
      onProgress: (update) => {
        if (update.phase !== 'trackChunks' || update.processed === 0) return;
        processedAtCancellation = update.processed;
        controller.abort(reason);
      }
    })).rejects.toBe(reason);

    expect(processedAtCancellation).toBe(500);
    expect(processedAtCancellation).toBeLessThan(tables.trackChunks.length);
    expect(mocks.tables.trackSnapshots.each).not.toHaveBeenCalled();
    expect(mocks.tables.media.each).not.toHaveBeenCalled();
    for (const table of Object.values(mocks.tables)) expect(table.toArray).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('releases point arrays and Blob payloads after each bounded batch', async () => {
    const tables = cleanTables();
    const weakChunks: WeakRef<object>[] = [];
    const weakPoints: WeakRef<object>[] = [];
    const weakBlobs: WeakRef<object>[] = [];
    function* chunkRows() {
      for (let index = 0; index < 1001; index++) {
        const points = [point(30, 120, index + 1)];
        const chunk = {
          id: `chunk-${String(index).padStart(4, '0')}`,
          tripId: 'trip-1', segmentId: 'segment-1', seq: index, points
        };
        weakChunks.push(new WeakRef(chunk));
        weakPoints.push(new WeakRef(points));
        yield chunk;
      }
    }
    function* mediaRows() {
      for (let index = 0; index < 501; index++) {
        const blob = new Blob(['photo']);
        weakBlobs.push(new WeakRef(blob));
        yield { id: `media-${String(index).padStart(4, '0')}`, tripId: 'trip-1', blob };
      }
    }
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    mockTableRows(mocks.tables.trackChunks, chunkRows);
    mockTableRows(mocks.tables.media, mediaRows);

    const v8Module = 'node:v8';
    const vmModule = 'node:vm';
    const [v8, vm] = await Promise.all([
      import(/* @vite-ignore */ v8Module),
      import(/* @vite-ignore */ vmModule)
    ]);
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const collectGarbage = () => {
      for (let index = 0; index < 5; index++) gc();
    };
    let chunksReleased = false;
    let blobsReleased = false;
    const result = await inspectStorageHealth({
      onProgress: (update) => {
        if (update.processed !== (update.phase === 'media' ? 500 : 1000)) return;
        if (update.phase === 'trackChunks') {
          collectGarbage();
          expect(weakChunks.slice(0, 500).every((reference) => reference.deref() === undefined)).toBe(true);
          expect(weakPoints.slice(0, 500).every((reference) => reference.deref() === undefined)).toBe(true);
          chunksReleased = true;
        }
        if (update.phase === 'media') {
          collectGarbage();
          expect(weakBlobs.slice(0, 500).every((reference) => reference.deref() === undefined)).toBe(true);
          blobsReleased = true;
        }
      }
    });

    expect(chunksReleased).toBe(true);
    expect(blobsReleased).toBe(true);
    expect(result.counts.trackChunks).toBe(1001);
    expect(result.counts.media).toBe(501);
    expect(result.counts.photoBytes).toBe(2505);
    expectNoWrites();
  });

  it('continues media pagination when a collected batch is deleted before row reads', async () => {
    const tables = cleanTables();
    tables.media = Array.from({ length: 501 }, (_, index) => ({
      id: `media-${String(index).padStart(4, '0')}`, tripId: 'trip-1', blob: new Blob(['photo'])
    }));
    for (const name of tableNames) mockTableRows(mocks.tables[name], () => tables[name]);
    const scan = mocks.tables.media.each.getMockImplementation()!;
    let deletedBatch = false;
    mocks.tables.media.each.mockImplementation(async (callback: ScanCallback) => {
      await scan(callback);
      if (!deletedBatch) {
        deletedBatch = true;
        tables.media.splice(0, 500);
      }
    });

    const result = await inspectStorageHealth();

    expect(result.counts.media).toBe(1);
    expect(mocks.tables.media.where).toHaveBeenCalledWith(':id');
    expect(mocks.tables.media.where.mock.results[0].value.above).toHaveBeenCalledWith('media-0499');
    expectNoWrites();
  });

  it('propagates database read failures without attempting repairs', async () => {
    mocks.tables.media.each.mockRejectedValue(new Error('read failed'));
    await expect(inspectStorageHealth()).rejects.toThrow('read failed');
    expectNoWrites();
  });
});
