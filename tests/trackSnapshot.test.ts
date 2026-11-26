import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db: any = {
    trackSnapshots: { where: vi.fn() },
    segments: { where: vi.fn(), update: vi.fn() },
    trackChunks: { where: vi.fn(), add: vi.fn() },
    trips: { update: vi.fn() },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn(),
    transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, rows: [] as any[], segments: [] as any[], snapshotQuery: { toArray: vi.fn(), each: vi.fn() } };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { getTrackSnapshotSummary, loadTrackSnapshot, restoreTrackSnapshot } from '../src/core/store';

const segment = { id: 'seg-1', tripId: 'trip-1', index: 0 };
const snapshot = (seq: number, overrides: any = {}) => ({
  id: `snapshot-${seq}`,
  tripId: 'trip-1',
  segmentId: 'seg-1',
  segmentIndex: 0,
  seq,
  createdAt: 1,
  points: [{ lat: 30, lon: 120, t: seq }],
  ...overrides
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.segments = [segment];
  mocks.db.transaction.mockImplementation(async (...args) => args[args.length - 1]());
  mocks.db.trackSnapshots.where.mockReturnValue({
    equals: () => mocks.snapshotQuery
  });
  mocks.snapshotQuery.toArray.mockImplementation(async () => mocks.rows);
  mocks.snapshotQuery.each.mockImplementation(async (callback: (row: any) => void) => {
    for (const row of mocks.rows) callback(row);
  });
  mocks.db.segments.where.mockReturnValue({
    equals: () => ({ toArray: async () => mocks.segments })
  });
  mocks.db.trackChunks.where.mockReturnValue({
    equals: () => ({ delete: vi.fn().mockResolvedValue(undefined) })
  });
});

describe('local original-track snapshots', () => {
  it('summarizes snapshots through a cursor without materializing every chunk', async () => {
    mocks.rows = [
      snapshot(0, { segmentId: 'seg-1', createdAt: 20, points: [{ lat: 30, lon: 120, t: 1 }] }),
      snapshot(1, { segmentId: 'seg-2', segmentIndex: 1, createdAt: 10, points: [{ lat: 30, lon: 120, t: 2 }, { lat: 31, lon: 121, t: 3 }] })
    ];

    await expect(getTrackSnapshotSummary('trip-1')).resolves.toEqual({ segments: 2, points: 3, createdAt: 10 });
    expect(mocks.snapshotQuery.each).toHaveBeenCalledOnce();
    expect(mocks.snapshotQuery.toArray).not.toHaveBeenCalled();
  });

  it('orders valid chunks by segment and sequence', async () => {
    mocks.rows = [
      snapshot(1, { points: [{ lat: 30, lon: 120.002, t: 2 }] }),
      snapshot(0, { points: [{ lat: 30, lon: 120.001, t: 1 }] })
    ];

    await expect(loadTrackSnapshot('trip-1')).resolves.toEqual([{
      id: 'seg-1',
      index: 0,
      createdAt: 1,
      points: [
        { lat: 30, lon: 120.001, t: 1 },
        { lat: 30, lon: 120.002, t: 2 }
      ]
    }]);
  });

  it.each([
    ['a missing sequence', [snapshot(1)]],
    ['a duplicate sequence', [snapshot(0), snapshot(0, { id: 'snapshot-duplicate' })]],
    ['a mismatched owner', [snapshot(0, { tripId: 'trip-2' })]],
    ['a missing segment', [snapshot(0, { segmentId: 'missing' })]],
    ['an invalid segment index', [snapshot(0, { segmentIndex: 1 })]],
    ['malformed points', [snapshot(0, { points: null })]],
    ['invalid coordinates', [snapshot(0, { points: [{ lat: 91, lon: 120, t: 1 }] })]],
    ['an invalid timestamp', [snapshot(0, { points: [{ lat: 30, lon: 120, t: NaN }] })]]
  ])('rejects %s before restore writes', async (_label, rows) => {
    mocks.rows = rows as any[];

    await expect(restoreTrackSnapshot('trip-1')).rejects.toThrow('invalid-snapshot');
    expect(mocks.db.trackChunks.add).not.toHaveBeenCalled();
    expect(mocks.db.segments.update).not.toHaveBeenCalled();
    expect(mocks.db.trips.update).not.toHaveBeenCalled();
  });
});
