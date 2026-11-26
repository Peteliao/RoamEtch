import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const media: any[] = [];
  const waypoints: any[] = [];
  const db: any = {
    media: {
      add: vi.fn(),
      delete: vi.fn()
    },
    waypoints: {
      add: vi.fn(),
      update: vi.fn(),
      filter: vi.fn()
    },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn(),
    transaction: vi.fn(),
    on: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, media, waypoints };
});

vi.mock('dexie', () => ({ default: class MockDexie { constructor() { return mocks.db; } } }));

import { saveWaypointWithMedia } from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.media.length = 0;
  mocks.waypoints.length = 0;
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.stores.mockReturnValue(mocks.db);
  mocks.db.upgrade.mockReturnValue(mocks.db);
  mocks.db.transaction.mockImplementation(async (_mode, _tables, task) => {
    const mediaBefore = [...mocks.media];
    const waypointsBefore = [...mocks.waypoints];
    try {
      return await task();
    } catch (error) {
      mocks.media.splice(0, mocks.media.length, ...mediaBefore);
      mocks.waypoints.splice(0, mocks.waypoints.length, ...waypointsBefore);
      throw error;
    }
  });
  mocks.db.media.add.mockImplementation(async (row) => { mocks.media.push(row); return row.id; });
  mocks.db.media.delete.mockImplementation(async (id) => {
    const index = mocks.media.findIndex((row) => row.id === id);
    if (index >= 0) mocks.media.splice(index, 1);
  });
  mocks.db.waypoints.filter.mockImplementation((predicate) => ({
    count: async () => mocks.waypoints.filter(predicate).length
  }));
  mocks.db.waypoints.add.mockImplementation(async (row) => { mocks.waypoints.push(row); return row.id; });
  mocks.db.waypoints.update.mockImplementation(async (id, patch) => {
    const row = mocks.waypoints.find((item) => item.id === id);
    if (row) Object.assign(row, patch);
    return 1;
  });
});

describe('waypoint media persistence', () => {
  it('adds photos and their waypoint reference in one transaction without deleting shared media', async () => {
    mocks.media.push({ id: 'shared', blob: new Blob(['shared']) });
    mocks.waypoints.push({ id: 'other', mediaIds: ['shared'] });
    const photo = { blob: new Blob(['photo']), thumb: new Blob(['thumb']), width: 10, height: 20 };

    const saved = await saveWaypointWithMedia({
      waypoint: { lat: 30, lon: 120, name: 'New', mediaIds: [] },
      tripId: 'trip-1', photos: [photo], removedMediaIds: ['shared'], isNew: true
    });

    expect(mocks.db.transaction).toHaveBeenCalledWith('rw', [mocks.db.media, mocks.db.waypoints], expect.any(Function));
    expect(saved.mediaIds).toHaveLength(1);
    expect(mocks.media.map((row) => row.id)).toEqual(['shared', saved.mediaIds[0]]);
    expect(mocks.waypoints[1].mediaIds).toEqual(saved.mediaIds);
  });

  it('deletes removed media only after its last waypoint reference is gone', async () => {
    mocks.media.push({ id: 'last-ref', blob: new Blob(['photo']) });
    mocks.waypoints.push({ id: 'wp-1', mediaIds: ['last-ref'] });

    await saveWaypointWithMedia({
      waypoint: { id: 'wp-1', mediaIds: [] }, tripId: 'trip-1', photos: [], removedMediaIds: ['last-ref'], isNew: false
    });

    expect(mocks.media).toHaveLength(0);
    expect(mocks.waypoints[0].mediaIds).toEqual([]);
  });

  it('rolls back newly added media when the waypoint write fails', async () => {
    mocks.db.waypoints.add.mockRejectedValueOnce(new Error('waypoint write failed'));
    await expect(saveWaypointWithMedia({
      waypoint: { lat: 30, lon: 120, mediaIds: [] }, tripId: 'trip-1',
      photos: [{ blob: new Blob(['photo']), thumb: null, width: 10, height: 20 }],
      removedMediaIds: [], isNew: true
    })).rejects.toThrow('waypoint write failed');
    expect(mocks.media).toHaveLength(0);
    expect(mocks.waypoints).toHaveLength(0);
  });

  it('rolls back media changes when a concurrently deleted waypoint cannot be updated', async () => {
    mocks.media.push({ id: 'old', blob: new Blob(['old']) });
    mocks.db.waypoints.update.mockResolvedValueOnce(0);

    await expect(saveWaypointWithMedia({
      waypoint: { id: 'missing', mediaIds: [] }, tripId: 'trip-1',
      photos: [{ blob: new Blob(['new']), thumb: null, width: 10, height: 20 }],
      removedMediaIds: ['old'], isNew: false
    })).rejects.toThrow('Waypoint no longer exists');

    expect(mocks.media).toEqual([{ id: 'old', blob: expect.any(Blob) }]);
    expect(mocks.waypoints).toHaveLength(0);
  });
});
