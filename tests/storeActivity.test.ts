import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const trips = { get: vi.fn(), update: vi.fn() };
  const db: any = {
    trips,
    segments: { update: vi.fn() },
    trackChunks: { update: vi.fn() },
    waypoints: { update: vi.fn() },
    media: { update: vi.fn() },
    version: vi.fn(),
    stores: vi.fn(),
    upgrade: vi.fn(),
    transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  return { db, trips };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { cacheTripStats, db, updateTrip } from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.stores.mockReturnValue(mocks.db);
  mocks.db.upgrade.mockReturnValue(mocks.db);
  mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => write());
  mocks.trips.update.mockResolvedValue(1);
});

afterEach(() => vi.useRealTimers());

describe('updateTrip activity changes', () => {
  it('atomically clears both derived fields when the activity genuinely changes', async () => {
    const current = {
      id: 'trip-1', activity: 'drive', name: 'Road trip', tags: ['old'],
      statsCache: { distance: 900, calories: null }, reportedDistance: 4321,
      privacy: { radius: 250, hideSensitive: true }, favorite: true
    };
    mocks.trips.get.mockResolvedValueOnce(current);

    await updateTrip('trip-1', { activity: 'hike', name: 'Mountain walk' });

    expect(db.transaction).toHaveBeenCalledWith('rw', db.trips, expect.any(Function));
    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', {
      activity: 'hike', name: 'Mountain walk', statsCache: null, reportedDistance: null,
      updatedAt: expect.any(Number)
    });
    expect(current.statsCache).toEqual({ distance: 900, calories: null });
    expect(current.reportedDistance).toBe(4321);
  });

  it('preserves cached statistics and reported distance for the same activity', async () => {
    mocks.trips.get.mockResolvedValueOnce({
      id: 'trip-1', activity: 'hike',
      statsCache: { distance: 800, calories: 91 }, reportedDistance: 777
    });

    await updateTrip('trip-1', { activity: 'hike', tags: ['weekend'] });

    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', {
      activity: 'hike', tags: ['weekend'], updatedAt: expect.any(Number)
    });
    const patch = mocks.trips.update.mock.calls[0][1];
    expect(patch).not.toHaveProperty('statsCache');
    expect(patch).not.toHaveProperty('reportedDistance');
  });

  it('atomically advances the revision for metadata-only updates', async () => {
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-1', activity: 'hike', updatedAt: 1000 });

    await updateTrip('trip-1', { name: 'Renamed' });

    expect(db.transaction).toHaveBeenCalledWith('rw', db.trips, expect.any(Function));
    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', {
      name: 'Renamed', updatedAt: expect.any(Number)
    });
  });

  it('allocates distinct revisions to same-millisecond edits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    mocks.trips.get
      .mockResolvedValueOnce({ id: 'trip-1', activity: 'hike', updatedAt: 1000 })
      .mockResolvedValueOnce({ id: 'trip-1', activity: 'hike', updatedAt: 1001 });

    await updateTrip('trip-1', { name: 'First' });
    await updateTrip('trip-1', { name: 'Second' });

    expect(mocks.trips.update.mock.calls.map((call) => call[1].updatedAt)).toEqual([1001, 1002]);
  });

  it('does not allocate a revision when touch is disabled', async () => {
    await updateTrip('trip-1', { thumbPoints: null }, { touch: false });

    expect(mocks.trips.get).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', { thumbPoints: null });
  });
});

describe('cacheTripStats', () => {
  it('atomically caches statistics without touching the trip timestamp', async () => {
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-1', updatedAt: 10 });
    const statsCache = { distance: 500, calories: null };

    await expect(cacheTripStats('trip-1', 10, statsCache)).resolves.toBe(true);

    expect(db.transaction).toHaveBeenCalledWith('rw', db.trips, expect.any(Function));
    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', { statsCache });
  });

  it('rejects a stale calculation without overwriting newer statistics', async () => {
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-1', updatedAt: 11 });

    await expect(cacheTripStats('trip-1', 10, { distance: 500 })).resolves.toBe(false);
    expect(mocks.trips.update).not.toHaveBeenCalled();
  });
});
