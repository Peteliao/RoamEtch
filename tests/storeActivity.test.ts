import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  return { db, trips };
});

vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor() { return mocks.db; }
  }
}));

import { db, updateTrip } from '../src/core/store';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.version.mockReturnValue(mocks.db);
  mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => write());
  mocks.trips.update.mockResolvedValue(1);
});

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

  it('does not read or start a transaction for metadata-only updates', async () => {
    await updateTrip('trip-1', { name: 'Renamed' });

    expect(mocks.trips.get).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.trips.update).toHaveBeenCalledWith('trip-1', {
      name: 'Renamed', updatedAt: expect.any(Number)
    });
  });
});
