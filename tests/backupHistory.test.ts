import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupHistoryRecord } from '../src/core/backupHistory';

const mocks = vi.hoisted(() => {
  let rows: any[] = [];
  let markers = new Map<string, any>();
  let nextId = 1;
  let failReads = false;
  let failWrites = false;
  const openedNames: string[] = [];

  const sortedRows = () => [...rows].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const records = {
    add: vi.fn(async (row: any) => {
      if (failWrites) throw new Error('history write failed');
      const stored = { ...row, id: nextId++ };
      rows.push(stored);
      return stored.id;
    }),
    orderBy: vi.fn((_index: string) => {
      const query = {
        reverse: () => query,
        toArray: async () => {
          if (failReads) throw new Error('history read failed');
          return sortedRows().reverse().map((row) => ({ ...row }));
        }
      };
      return query;
    }),
    bulkDelete: vi.fn(async (ids: number[]) => {
      if (failWrites) throw new Error('history delete failed');
      const removed = new Set(ids);
      rows = rows.filter((row) => !removed.has(row.id));
    }),
    clear: vi.fn(async () => {
      if (failWrites) throw new Error('history clear failed');
      rows = [];
    })
  };
  const meta = {
    get: vi.fn(async (key: string) => {
      if (failReads) throw new Error('history read failed');
      return markers.get(key);
    }),
    put: vi.fn(async (marker: { key: string; value: boolean }) => {
      if (failWrites) throw new Error('history write failed');
      markers.set(marker.key, { ...marker });
    })
  };
  const db: any = {
    records,
    meta,
    version: vi.fn(),
    stores: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    table: vi.fn((name: string) => name === 'records' ? records : meta),
    transaction: vi.fn(async (_mode: string, _tables: any[], run: () => Promise<any>) => {
      const previousRows = rows.map((row) => ({ ...row }));
      const previousMarkers = new Map(markers);
      const previousNextId = nextId;
      try {
        return await run();
      } catch (error) {
        rows = previousRows;
        markers = previousMarkers;
        nextId = previousNextId;
        throw error;
      }
    })
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  const getSetting = vi.fn(() => 0);

  return {
    db,
    records,
    getSetting,
    openedNames,
    rows: () => rows,
    markers: () => markers,
    seed: (seeded: any[]) => {
      rows = seeded.map((row) => ({ ...row, id: row.id ?? nextId++ }));
      nextId = Math.max(nextId, ...rows.map((row) => row.id + 1));
    },
    failReads: () => { failReads = true; },
    failWrites: () => { failWrites = true; },
    reset: () => {
      rows = [];
      markers = new Map();
      nextId = 1;
      failReads = false;
      failWrites = false;
      openedNames.length = 0;
      getSetting.mockReturnValue(0);
      vi.clearAllMocks();
      db.version.mockReturnValue(db);
      db.stores.mockReturnValue(db);
    }
  };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor(name: string) {
      mocks.openedNames.push(name);
      return mocks.db;
    }
  }
}));
vi.mock('../src/core/settings', () => ({ get: mocks.getSetting }));

const loadModule = () => import('../src/core/backupHistory');

function validRecord(overrides: Partial<BackupHistoryRecord> = {}): BackupHistoryRecord {
  return {
    kind: 'export',
    status: 'exported',
    createdAt: 1_700_000_000_000,
    filename: 'roametch-backup-20261126.trip',
    bytes: 12345,
    encrypted: false,
    backupFormat: 'localtrace-backup',
    tripSchema: 1,
    appVersion: '3.4.0',
    trips: 2,
    segments: 3,
    chunks: 4,
    waypoints: 5,
    media: 6,
    mediaChecked: 7,
    mediaFailed: 0,
    source: 'manual',
    ...overrides
  };
}

beforeEach(() => {
  mocks.reset();
  vi.resetModules();
});

describe('backup history', () => {
  it('stores a valid record in its own versioned database without sensitive extras', async () => {
    const history = await loadModule();
    const record = validRecord();
    const input = {
      ...record,
      password: 'do-not-store',
      blob: new Blob(['track data']),
      path: 'C:\\private\\track.gpx',
      handle: { name: 'track.gpx' },
      points: [{ lat: 30, lon: 120 }]
    } as BackupHistoryRecord;

    await expect(history.appendBackupHistory(input)).resolves.toBe(true);
    await expect(history.listBackupHistory()).resolves.toEqual([record]);
    expect(mocks.openedNames).toEqual(['localtrace-backup-history']);
    expect(mocks.db.version).toHaveBeenCalledWith(1);
    expect(mocks.db.stores).toHaveBeenCalledWith({ records: '++id,createdAt', meta: 'key' });
    expect(mocks.records.orderBy).toHaveBeenCalledWith('createdAt');
    expect(mocks.rows()[0]).toEqual({ ...record, id: 1 });
  });

  it('accepts all supported statuses and operation sources', async () => {
    const history = await loadModule();
    const expected = [
      validRecord({ createdAt: 4, kind: 'export', status: 'exported', source: 'pre-restore' }),
      validRecord({ createdAt: 3, kind: 'restore', status: 'restored', source: 'manual' }),
      validRecord({ createdAt: 2, kind: 'drill', status: 'drill-passed', source: 'drill' }),
      validRecord({ createdAt: 1, kind: 'export', status: 'failed', source: 'manual' })
    ];
    for (const record of expected) expect(await history.appendBackupHistory(record)).toBe(true);

    await expect(history.listBackupHistory()).resolves.toEqual(expected);
  });

  it('persists records across a module reload', async () => {
    const first = await loadModule();
    const record = validRecord();
    expect(await first.appendBackupHistory(record)).toBe(true);

    vi.resetModules();
    const reloaded = await loadModule();
    await expect(reloaded.listBackupHistory()).resolves.toEqual([record]);
  });

  it('keeps only the newest 20 records', async () => {
    const history = await loadModule();
    for (let index = 0; index < 25; index++) {
      expect(await history.appendBackupHistory(validRecord({
        createdAt: 1_700_000_000_000 + index,
        filename: `backup-${index}.trip`
      }))).toBe(true);
    }

    const listed = await history.listBackupHistory();
    expect(listed).toHaveLength(20);
    expect(mocks.rows()).toHaveLength(20);
    expect(listed[0].filename).toBe('backup-24.trip');
    expect(listed.at(-1)?.filename).toBe('backup-5.trip');
  });

  it('discards corrupted records when reading', async () => {
    const history = await loadModule();
    const valid = validRecord();
    expect(await history.appendBackupHistory(valid)).toBe(true);
    const base = { ...valid, createdAt: 1_700_000_000_001 };
    mocks.seed([
      { ...valid, id: 1 },
      { ...base, kind: 'delete' },
      { ...base, status: 'complete' },
      { ...base, source: 'automatic' },
      { ...base, createdAt: 0 },
      { ...base, createdAt: 'yesterday' },
      { ...base, filename: '' },
      { ...base, filename: '../private.trip' },
      { ...base, filename: 'C:\\private\\backup.trip' },
      { ...base, bytes: -1 },
      { ...base, bytes: 1.5 },
      { ...base, encrypted: 'false' },
      { ...base, backupFormat: '' },
      { ...base, tripSchema: -1 },
      { ...base, appVersion: '' },
      { ...base, trips: -1 },
      { ...base, segments: 0.5 },
      { ...base, chunks: Number.NaN },
      { ...base, waypoints: '5' },
      { ...base, media: Number.POSITIVE_INFINITY },
      { ...base, mediaChecked: -1 },
      { ...base, mediaFailed: 1.5 }
    ]);

    await expect(history.listBackupHistory()).resolves.toEqual([valid]);
  });

  it('imports lastBackupAt once as a legacy record', async () => {
    const at = 1_700_000_000_000;
    mocks.getSetting.mockReturnValue(at);
    const history = await loadModule();

    const listed = await history.listBackupHistory();
    expect(listed).toEqual([expect.objectContaining({
      kind: 'export', status: 'exported', createdAt: at, filename: '',
      source: 'legacy', trips: 0, media: 0
    })]);
    expect(mocks.getSetting).toHaveBeenCalledWith('lastBackupAt');
    await expect(history.listBackupHistory()).resolves.toEqual(listed);
    expect(mocks.rows()).toHaveLength(1);

    vi.resetModules();
    const reloaded = await loadModule();
    await expect(reloaded.listBackupHistory()).resolves.toEqual(listed);
  });

  it('imports legacy history before appending a failed first backup', async () => {
    const at = 1_700_000_000_000;
    mocks.getSetting.mockReturnValue(at);
    const history = await loadModule();
    const failed = validRecord({
      createdAt: at + 1_000, kind: 'export', status: 'failed', source: 'manual'
    });

    expect(await history.appendBackupHistory(failed)).toBe(true);
    const listed = await history.listBackupHistory();
    expect(listed).toHaveLength(2);
    expect(listed).toContainEqual(expect.objectContaining({ createdAt: at, source: 'legacy', status: 'exported' }));
    expect(listed).toContainEqual(failed);
    expect(await history.getLatestSuccessfulExport()).toEqual(expect.objectContaining({
      createdAt: at, source: 'legacy', status: 'exported'
    }));
  });

  it('does not remove history when backup preferences change', async () => {
    const history = await loadModule();
    const record = validRecord();
    expect(await history.appendBackupHistory(record)).toBe(true);

    mocks.getSetting.mockReturnValue(0);
    await expect(history.listBackupHistory()).resolves.toEqual([record]);
  });

  it('clears explicitly and does not re-import legacy history afterward', async () => {
    mocks.getSetting.mockReturnValue(1_700_000_000_000);
    const history = await loadModule();
    expect(await history.listBackupHistory()).toHaveLength(1);
    expect(await history.appendBackupHistory(validRecord({ createdAt: 1_700_000_001_000 }))).toBe(true);

    await expect(history.clearBackupHistory()).resolves.toBe(true);
    await expect(history.listBackupHistory()).resolves.toEqual([]);
    expect(mocks.rows()).toEqual([]);

    vi.resetModules();
    const reloaded = await loadModule();
    await expect(reloaded.listBackupHistory()).resolves.toEqual([]);
    await expect(reloaded.clearBackupHistory()).resolves.toBe(true);
  });

  it('returns the newest successful export rather than a restore or failure', async () => {
    const history = await loadModule();
    const successful = validRecord({ createdAt: 1_700_000_000_000 });
    expect(await history.appendBackupHistory(successful)).toBe(true);
    expect(await history.appendBackupHistory(validRecord({
      createdAt: 1_700_000_001_000, kind: 'export', status: 'failed'
    }))).toBe(true);
    expect(await history.appendBackupHistory(validRecord({
      createdAt: 1_700_000_002_000, kind: 'restore', status: 'restored'
    }))).toBe(true);

    await expect(history.getLatestSuccessfulExport()).resolves.toEqual(successful);
  });

  it('degrades invalid writes and failed reads without throwing', async () => {
    const history = await loadModule();
    await expect(history.appendBackupHistory(validRecord({ bytes: -1 }))).resolves.toBe(false);

    mocks.failWrites();
    await expect(history.appendBackupHistory(validRecord())).resolves.toBe(false);
    await expect(history.listBackupHistory()).resolves.toEqual([]);
    await expect(history.getLatestSuccessfulExport()).resolves.toBeNull();

    mocks.reset();
    const record = validRecord();
    mocks.seed([{ ...record, id: 1 }]);
    mocks.failReads();
    await expect(history.listBackupHistory()).resolves.toEqual([]);
    await expect(history.getLatestSuccessfulExport()).resolves.toBeNull();
  });

  it('reports clear and legacy migration failures without losing existing data', async () => {
    const history = await loadModule();
    const record = validRecord();
    mocks.seed([{ ...record, id: 1 }]);
    mocks.failWrites();

    await expect(history.clearBackupHistory()).resolves.toBe(false);
    expect(mocks.rows()).toEqual([{ ...record, id: 1 }]);

    mocks.reset();
    mocks.getSetting.mockReturnValue(1_700_000_000_000);
    mocks.failWrites();
    await expect(history.listBackupHistory()).resolves.toEqual([]);
    expect(mocks.rows()).toEqual([]);
  });
});
