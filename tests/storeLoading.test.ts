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
  return { db, trips, segments, chunks, previewChunkReads: [] as string[] };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import {
  loadFirstTrackPoint, loadLastTrackTimestamp, loadTripFull, loadTripPreview, loadTripTrack,
  pruneEmptySegments
} from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trips.clear();
  mocks.segments.length = 0;
  mocks.chunks.length = 0;
  mocks.previewChunkReads.length = 0;
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
  mocks.db.trackChunks.where.mockImplementation((index: string) => {
    if (index === '[segmentId+seq]') {
      return {
        between: ([segmentId, min]: [string, number], [, max]: [string, number]) => {
          const rows = () => mocks.chunks
            .filter((chunk) => chunk.segmentId === segmentId && chunk.seq >= min && chunk.seq <= max)
            .sort((a, b) => a.seq - b.seq);
          return {
            toArray: async () => rows(),
            count: async () => rows().length,
            last: async () => rows().at(-1),
            offset: (offset: number) => ({
              limit: (limit: number) => ({
                toArray: async () => {
                  const selected = rows().slice(offset, offset + limit);
                  mocks.previewChunkReads.push(...selected.map((chunk) => chunk.id));
                  return selected;
                }
              })
            }),
            reverse: () => ({
              each: async (visit) => {
                for (const row of [...rows()].reverse()) if (visit(row) === false) break;
              }
            }),
            each: async (visit) => {
              for (const row of rows()) if (visit(row) === false) break;
            }
          };
        }
      };
    }
    return {
      equals: (value: string) => ({
        toArray: async () => mocks.chunks.filter((chunk) => chunk[index] === value),
        count: async () => mocks.chunks.filter((chunk) => chunk[index] === value).length,
        delete: async () => {
          for (let i = mocks.chunks.length - 1; i >= 0; i--) {
            if (mocks.chunks[i][index] === value) mocks.chunks.splice(i, 1);
          }
        }
      })
    };
  });
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

  it('reuses an unchanged track snapshot while reloading trip metadata, waypoints, and media', async () => {
    mocks.trips.set('trip-1', { id: 'trip-1', updatedAt: 5, name: 'Current name' });
    const segments = [{ id: 'seg-1', tripId: 'trip-1', index: 0, points: [{ lat: 30, lon: 120 }] }];
    const trackSnapshot = { trip: { id: 'trip-1', updatedAt: 5 }, segments };

    const full = await loadTripFull('trip-1', { trackSnapshot });

    expect(full?.trip.name).toBe('Current name');
    expect(full?.segments).toBe(segments);
    expect(full?.waypoints).toEqual([{ id: 'wp-1', tripId: 'trip-1' }]);
    expect(full?.media).toEqual([{ id: 'media-1', tripId: 'trip-1' }]);
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalled();
  });

  it('reloads track chunks when the cached snapshot version is stale', async () => {
    mocks.trips.set('trip-1', { id: 'trip-1', updatedAt: 6 });
    mocks.segments.push({ id: 'seg-1', tripId: 'trip-1', index: 0 });
    mocks.chunks.push({ id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0, points: [{ lat: 31, lon: 121 }] });
    const trackSnapshot = { trip: { id: 'trip-1', updatedAt: 5 }, segments: [] };

    const full = await loadTripFull('trip-1', { trackSnapshot });

    expect(full?.segments[0].points).toEqual([{ lat: 31, lon: 121 }]);
    expect(mocks.db.trackChunks.where).toHaveBeenCalledWith('[segmentId+seq]');
  });

  it('finds the first valid point without materializing the track', async () => {
    mocks.segments.push(
      { id: 'empty', tripId: 'trip-1', index: 0 },
      { id: 'seg-1', tripId: 'trip-1', index: 1 }
    );
    mocks.chunks.push(
      { id: 'later', segmentId: 'seg-1', seq: 1, points: [{ lat: 31, lon: 121, t: 2 }] },
      { id: 'empty-chunk', segmentId: 'seg-1', seq: 0, points: [] },
      { id: 'first', segmentId: 'seg-1', seq: 0, points: [{ lat: 30, lon: 120, t: 1 }] }
    );

    await expect(loadFirstTrackPoint('trip-1')).resolves.toEqual({ lat: 30, lon: 120 });
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalledWith('tripId');
  });

  it('reads the latest timestamp from the last non-empty chunk', async () => {
    mocks.chunks.push(
      { id: 'first', segmentId: 'seg-1', seq: 0, points: [{ t: 500 }] },
      { id: 'last-empty', segmentId: 'seg-1', seq: 3, points: [] },
      { id: 'last', segmentId: 'seg-1', seq: 2, points: [{ t: 700 }, { t: 900 }] }
    );

    await expect(loadLastTrackTimestamp('seg-1')).resolves.toBe(900);
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalledWith('segmentId');
  });

  it('builds a bounded read-only preview without loading media or every chunk', async () => {
    mocks.trips.set('trip-1', { id: 'trip-1', name: 'Large trip' });
    mocks.segments.push(
      { id: 'seg-1', tripId: 'trip-1', index: 0 },
      { id: 'seg-2', tripId: 'trip-1', index: 1 },
      { id: 'empty', tripId: 'trip-1', index: 2 }
    );
    for (let seq = 0; seq < 20; seq++) {
      mocks.chunks.push({
        id: `chunk-${seq}`, segmentId: 'seg-1', seq,
        points: Array.from({ length: 400 }, (_, index) => ({
          lat: 30, lon: 120 + (seq * 400 + index) / 1_000_000, t: seq * 400 + index
        }))
      });
    }
    mocks.chunks.push({
      id: 'final', segmentId: 'seg-2', seq: 0,
      points: [{ lat: 31, lon: 121, t: 9000 }, { lat: 31.001, lon: 121.001, t: 9001 }]
    });

    const preview = await loadTripPreview('trip-1');

    expect(preview?.readOnly).toBe(true);
    expect(mocks.previewChunkReads).toHaveLength(16);
    expect(new Set(mocks.previewChunkReads).size).toBe(16);
    expect(preview?.segments.flatMap((segment) => segment.points)).toHaveLength(500);
    expect(preview?.segments[0].points[0].t).toBe(0);
    expect(preview?.segments[1].points.length).toBeGreaterThan(0);
    expect(preview?.segments[1].points.at(-1).t).toBe(9001);
    expect(preview?.segments[2].points).toEqual([]);
    expect(preview?.waypoints).toEqual([{ id: 'wp-1', tripId: 'trip-1' }]);
    expect(preview).not.toHaveProperty('media');
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalledWith('tripId');
    expect(mocks.db.media.where).not.toHaveBeenCalled();
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
