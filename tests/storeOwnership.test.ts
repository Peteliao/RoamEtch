import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const segments = new Map<string, any>();
  const chunks = new Map<string, any>();
  const db: any = {
    segments: {
      get: vi.fn(async (id: string) => segments.get(id)),
      update: vi.fn(async (id: string, patch: any) => {
        const segment = segments.get(id);
        if (segment) segments.set(id, { ...segment, ...patch });
      })
    },
    trackChunks: {
      where: vi.fn(),
      add: vi.fn(async (row: any) => { chunks.set(row.id, row); })
    },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, segments, chunks };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { replaceSegmentPointsInTx } from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.segments.clear();
  mocks.chunks.clear();
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.stores.mockReturnValue(mocks.db);
  mocks.db.upgrade.mockReturnValue(mocks.db);
  mocks.db.trackChunks.where.mockImplementation((index: string) => {
    expect(index).toBe('segmentId');
    return {
      equals: (segmentId: string) => ({
        delete: vi.fn(async () => {
          for (const [id, chunk] of mocks.chunks) {
            if (chunk.segmentId === segmentId) mocks.chunks.delete(id);
          }
        })
      })
    };
  });
});

describe('segment point ownership', () => {
  it('rejects another trip segment before querying or deleting its chunks', async () => {
    mocks.segments.set('seg-b', { id: 'seg-b', tripId: 'b', startTime: 1, endTime: 1 });
    const originalChunk = {
      id: 'chunk-b', tripId: 'b', segmentId: 'seg-b', seq: 0,
      points: [{ lat: 30, lon: 120, t: 1 }]
    };
    mocks.chunks.set(originalChunk.id, originalChunk);

    await expect(replaceSegmentPointsInTx('seg-b', 'a', [
      { lat: 31, lon: 121, t: 2 }
    ])).rejects.toThrow('segment-trip-mismatch');

    expect(mocks.chunks.get('chunk-b')).toBe(originalChunk);
    expect(mocks.db.trackChunks.where).not.toHaveBeenCalled();
    expect(mocks.db.trackChunks.add).not.toHaveBeenCalled();
    expect(mocks.db.segments.update).not.toHaveBeenCalled();
  });

  it('still replaces chunks when the segment belongs to the supplied trip', async () => {
    mocks.segments.set('seg-a', { id: 'seg-a', tripId: 'a', startTime: 1, endTime: 1 });
    mocks.chunks.set('old-chunk', {
      id: 'old-chunk', tripId: 'a', segmentId: 'seg-a', seq: 0,
      points: [{ lat: 30, lon: 120, t: 1 }]
    });
    const points = [{ lat: 31, lon: 121, t: 2 }];

    await replaceSegmentPointsInTx('seg-a', 'a', points);

    expect(mocks.chunks.has('old-chunk')).toBe(false);
    expect([...mocks.chunks.values()]).toEqual([
      expect.objectContaining({ tripId: 'a', segmentId: 'seg-a', seq: 0, points })
    ]);
    expect(mocks.segments.get('seg-a')).toMatchObject({ startTime: 2, endTime: 2 });
  });
});
