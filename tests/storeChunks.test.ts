import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const chunks = new Map<string, any>();
  const db: any = {
    trackChunks: {
      where: vi.fn(),
      add: vi.fn(async (row) => { chunks.set(row.id, row); }),
      put: vi.fn(async (row) => { chunks.set(row.id, row); })
    },
    segments: { update: vi.fn() },
    trips: { get: vi.fn(), update: vi.fn() },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn(),
    transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, chunks };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { appendPoints, CHUNK_SIZE } from '../src/core/store';

function point(t: number) {
  return { lat: 30, lon: 120, t };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chunks.clear();
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.stores.mockReturnValue(mocks.db);
  mocks.db.upgrade.mockReturnValue(mocks.db);
  mocks.db.transaction.mockImplementation(async (...args) => args[args.length - 1]());
  mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 1 });
  mocks.db.trackChunks.where.mockImplementation((index) => ({
    between: (lower: [string, number], upper: [string, number]) => ({
      last: async () => [...mocks.chunks.values()]
        .filter((chunk) => chunk.segmentId >= lower[0] && chunk.segmentId <= upper[0]
          && chunk.seq >= lower[1] && chunk.seq <= upper[1])
        .sort((a, b) => a.seq - b.seq)
        .at(-1)
    })
  }));
});

describe('track chunk appends', () => {
  it('appends to the highest sequence rather than the greatest primary key', async () => {
    const older = { id: 'z-older', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: Array(CHUNK_SIZE - 1).fill(point(1)) };
    const newer = { id: 'a-newer', tripId: 'trip-1', segmentId: 'seg-1', seq: 1, points: [point(2)] };
    mocks.chunks.set(older.id, older);
    mocks.chunks.set(newer.id, newer);

    await appendPoints('seg-1', 'trip-1', [point(3)]);

    expect(mocks.db.trackChunks.where).toHaveBeenCalledWith('[segmentId+seq]');
    expect(mocks.chunks.get(older.id)).toBe(older);
    expect(older.points).toHaveLength(CHUNK_SIZE - 1);
    expect(newer.points).toHaveLength(2);
    expect(mocks.db.trackChunks.add).not.toHaveBeenCalled();
  });

  it('starts at sequence zero and splits oversized batches contiguously', async () => {
    const points = Array.from({ length: CHUNK_SIZE + 1 }, (_, index) => point(index));

    await appendPoints('seg-1', 'trip-1', points);

    const rows = [...mocks.chunks.values()].sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(rows.map((row) => row.points.length)).toEqual([CHUNK_SIZE, 1]);
    expect(rows.flatMap((row) => row.points)).toEqual(points);
  });

  it('creates the next sequence when the latest chunk is full', async () => {
    mocks.chunks.set('latest', {
      id: 'latest', tripId: 'trip-1', segmentId: 'seg-1', seq: 4,
      points: Array(CHUNK_SIZE).fill(point(1))
    });

    await appendPoints('seg-1', 'trip-1', [point(2)]);

    const rows = [...mocks.chunks.values()];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== 'latest')?.seq).toBe(5);
  });
});
