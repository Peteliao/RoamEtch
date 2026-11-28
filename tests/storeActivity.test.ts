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

import { appendTripWeatherSample, cacheTripStats, db, updateTrip } from '../src/core/store';

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

describe('appendTripWeatherSample', () => {
  const sample = (time: number, alerts: any[] = []) => ({
    time, lat: 30, lon: 120, source: 'Open-Meteo', providerId: 'open-meteo', alerts,
    summary: {
      temp: 20, code: 1, rain: 10, wind: 8, uv: 2,
      hour: 9, sample: '2026-11-20 09:00', missing: []
    }
  });

  it('appends only weatherLog inside a read-write transaction and preserves updatedAt', async () => {
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-weather', updatedAt: 123, weatherLog: [] });
    await expect(appendTripWeatherSample('trip-weather', sample(1000))).resolves.toBe(true);
    expect(db.transaction).toHaveBeenCalledWith('rw', db.trips, expect.any(Function));
    const patch = mocks.trips.update.mock.calls[0][1];
    expect(patch.weatherLog).toHaveLength(1);
    expect(patch).not.toHaveProperty('updatedAt');
  });

  it('rejects duplicate minute, source and rounded-coordinate samples', async () => {
    mocks.trips.get.mockResolvedValueOnce({
      id: 'trip-weather', weatherLog: [sample(60_000)]
    });
    await expect(appendTripWeatherSample('trip-weather', sample(61_000))).resolves.toBe(false);
    expect(mocks.trips.update).not.toHaveBeenCalled();
  });

  it('bounds long recordings while retaining the first, last and alert samples', async () => {
    const start = new Date(2026, 0, 1).getTime();
    const existing = Array.from({ length: 730 }, (_, index) => sample(
      start + index * 60_000,
      index === 360 ? [{ level: 'extreme', kind: 'thunderstorm' }] : []
    ));
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-weather', weatherLog: existing });
    await appendTripWeatherSample('trip-weather', sample(start + 730 * 60_000));

    const stored = mocks.trips.update.mock.calls[0][1].weatherLog;
    expect(stored.length).toBeLessThanOrEqual(720);
    expect(stored[0].time).toBe(start);
    expect(stored[stored.length - 1].time).toBe(start + 730 * 60_000);
    expect(stored.some((entry: any) => entry.alerts.some((alert: any) => alert.kind === 'thunderstorm'))).toBe(true);
  });

  it('rejects missing trips and invalid samples without writing', async () => {
    mocks.trips.get.mockResolvedValueOnce(null);
    await expect(appendTripWeatherSample('missing', sample(1000))).resolves.toBe(false);
    mocks.trips.get.mockResolvedValueOnce({ id: 'trip-weather', weatherLog: [] });
    await expect(appendTripWeatherSample('trip-weather', { ...sample(1000), lat: 91 })).resolves.toBe(false);
    expect(mocks.trips.update).not.toHaveBeenCalled();
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
