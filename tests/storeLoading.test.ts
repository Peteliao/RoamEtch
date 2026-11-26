import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const trips = new Map<string, any>();
  const segments: any[] = [];
  const chunks: any[] = [];
  const db: any = {
    trips: { get: vi.fn(async (id: string) => trips.get(id)) },
    segments: {
      where: vi.fn(),
      delete: vi.fn(async (id: string) => {
        const index = segments.findIndex((segment) => segment.id === id);
        if (index >= 0) segments.splice(index, 1);
      })
    },
    trackChunks: { where: vi.fn() },
    waypoints: { where: vi.fn() },
    media: { where: vi.fn() },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn(),
    transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, trips, segments, chunks };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { loadTripFull, loadTripTrack, pruneEmptySegments } from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trips.clear();
  mocks.segments.length = 0;
  mocks.chunks.length = 0;
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.stores.mockReturnValue(mocks.db);
  mocks.db.upgrade.mockReturnValue(mocks.db);
  mocks.db.transaction.mockImplementation(async (...args) => args[args.length - 1]());
  mocks.db.segments.where.mockImplementation((index: string) => ({
    equals: (value: string) => ({
      sortBy: async () => mocks.segments
        .filter((segment) => segment[index] === value)
        .sort((a, b) => a.index - b.index)
    })
  }));
  mocks.db.trackChunks.where.mockImplementation((index: string) => ({
    equals: (value: string) => ({
      toArray: async () => mocks.chunks.filter((chunk) => chunk[index] === value),
      count: async () => mocks.chunks.filter((chunk) => chunk[index] === value).length,
      delete: async () => {
        for (let i = mocks.chunks.length - 1; i >= 0; i--) {
          if (mocks.chunks[i][index] === value) mocks.chunks.splice(i, 1);
        }
      }
    })
  }));
  mocks.db.waypoints.where.mockImplementation((index: string) => ({
    equals: (value: string) => ({ toArray: async () => [{ id: 'wp-1', [index]: value }] })
  }));
  mocks.db.media.where.mockImplementation((index: string) => ({
    equals: (value: string) => ({ toArray: async () => [{ id: 'media-1', [index]: value }] })
  }));
});

describe('trip loading', () => {
  it('loads ordered track points without reading waypoints or media', async () => {
    mocks.trips.set('trip-1', { id: 'trip-1' });
    mocks.segments.push(
      { id: 'seg-1', tripId: 'trip-1', index: 0 },
      { id: 'seg-2', tripId: 'trip-1', index: 1 }
    );
    mocks.chunks.push(
      { id: 'c2', tripId: 'trip-1', segmentId: 'seg-1', seq: 1, points: [{ t: 2 }] },
      { id: 'c1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [{ t: 1 }] },
      { id: 'orphan', tripId: 'trip-1', segmentId: 'missing', seq: 0, points: [{ t: 9 }] }
    );

    const track = await loadTripTrack('trip-1');

    expect(track?.segments.map((segment) => segment.points)).toEqual([[{ t: 1 }, { t: 2 }], []]);
    expect(mocks.db.waypoints.where).not.toHaveBeenCalled();
    expect(mocks.db.media.where).not.toHaveBeenCalled();
  });

  it('keeps full loading available for callers that need waypoints and media', async () => {
    mocks.trips.set('trip-1', { id: 'trip-1' });

    const full = await loadTripFull('trip-1');

    expect(full?.waypoints).toEqual([{ id: 'wp-1', tripId: 'trip-1' }]);
    expect(full?.media).toEqual([{ id: 'media-1', tripId: 'trip-1' }]);
  });
});

describe('empty segment pruning', () => {
  it('uses chunk counts and never materializes track points', async () => {
    mocks.segments.push(
      { id: 'seg-1', tripId: 'trip-1', index: 0 },
      { id: 'seg-2', tripId: 'trip-1', index: 1 },
      { id: 'seg-3', tripId: 'trip-1', index: 2 }
    );
    mocks.chunks.push(
      { segmentId: 'seg-1', points: [{ t: 1 }] },
      { segmentId: 'seg-3', points: [{ t: 3 }] },
      { segmentId: 'seg-3', points: [{ t: 4 }] }
    );

    await expect(pruneEmptySegments('trip-1')).resolves.toBe(1);

    expect(mocks.segments.map((segment) => segment.id)).toEqual(['seg-1', 'seg-3']);
    expect(mocks.chunks.every((chunk) => chunk.segmentId !== 'seg-2')).toBe(true);
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalledWith('tripId');
  });
});
