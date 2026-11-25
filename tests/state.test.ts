import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTripFull: vi.fn(),
  updateTrip: vi.fn(),
  computeStatsAsync: vi.fn(),
  emit: vi.fn(),
  set: vi.fn(),
  backfillTripAltitudes: vi.fn()
}));

vi.mock('../src/core/store', () => ({
  loadTripFull: mocks.loadTripFull,
  updateTrip: mocks.updateTrip
}));
vi.mock('../src/core/workerBridge', () => ({ computeStatsAsync: mocks.computeStatsAsync }));
vi.mock('../src/core/settings', () => ({
  get: (key: string) => ({ ascentThreshold: 4, weightKg: 70 }[key]),
  set: mocks.set
}));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/elevation', () => ({ backfillTripAltitudes: mocks.backfillTripAltitudes }));

import { appState, isTripSectionActive, recalcNow, refreshActiveTrip, setActiveTrip } from '../src/ui/state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function full(id: string, name: string) {
  return {
    trip: { id, name, activity: 'hike', reportedDistance: null },
    segments: [{ id: `${id}-segment`, points: [] }],
    waypoints: [],
    media: []
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  appState.view = 'record';
  appState.activeTripId = null;
  appState.activeTripFull = null;
  appState.stats = null;
  appState.tripDetail = { open: false, tripId: null, section: 'overview' };
  mocks.updateTrip.mockResolvedValue(undefined);
  mocks.computeStatsAsync.mockResolvedValue({ distance: 1, segments: [] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('active trip snapshots', () => {
  it('recognizes only the visible nested trip section', () => {
    appState.view = 'trips';
    appState.tripDetail = { open: true, tripId: 'a', section: 'share' };
    expect(isTripSectionActive('share')).toBe(true);
    expect(isTripSectionActive('overview')).toBe(false);
    appState.view = 'record';
    expect(isTripSectionActive('share')).toBe(false);
  });

  it('closes an unrelated trip detail as soon as selection changes', async () => {
    const next = deferred<ReturnType<typeof full>>();
    appState.activeTripId = 'a';
    appState.tripDetail = { open: true, tripId: 'a', section: 'data' };
    mocks.loadTripFull.mockReturnValueOnce(next.promise);

    const pending = setActiveTrip('b');
    expect(appState.tripDetail).toEqual({ open: false, tripId: null, section: 'overview' });
    next.resolve(full('b', 'Next trip'));
    await pending;
  });

  it('does not let an older trip selection overwrite a newer one', async () => {
    const a = deferred<ReturnType<typeof full>>();
    const b = deferred<ReturnType<typeof full>>();
    mocks.loadTripFull.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const pendingA = setActiveTrip('a');
    const pendingB = setActiveTrip('b');
    b.resolve(full('b', 'New trip'));
    await pendingB;
    a.resolve(full('a', 'Old trip'));
    await pendingA;

    expect(appState.activeTripId).toBe('b');
    expect(appState.activeTripFull?.trip.name).toBe('New trip');
    expect(mocks.emit).not.toHaveBeenCalledWith('trip:active', expect.objectContaining({ trip: expect.objectContaining({ id: 'a' }) }));
  });

  it('keeps the newest same-trip refresh when loads finish out of order', async () => {
    const oldLoad = deferred<ReturnType<typeof full>>();
    const newLoad = deferred<ReturnType<typeof full>>();
    appState.activeTripId = 'a';
    mocks.loadTripFull.mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise);

    const pendingOld = refreshActiveTrip();
    const pendingNew = refreshActiveTrip();
    newLoad.resolve(full('a', 'Edited snapshot'));
    await pendingNew;
    oldLoad.resolve(full('a', 'Stale snapshot'));
    await pendingOld;

    expect(appState.activeTripFull?.trip.name).toBe('Edited snapshot');
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith('trip:active', expect.objectContaining({ trip: expect.objectContaining({ name: 'Edited snapshot' }) }));
  });

  it('can load a recording trip without disturbing the selected trip', async () => {
    const selected = deferred<ReturnType<typeof full>>();
    const recording = deferred<ReturnType<typeof full>>();
    mocks.loadTripFull.mockReturnValueOnce(selected.promise).mockReturnValueOnce(recording.promise);

    const pendingSelected = setActiveTrip('selected');
    const pendingRecording = refreshActiveTrip('recording');
    recording.resolve(full('recording', 'Recording snapshot'));
    await expect(pendingRecording).resolves.toMatchObject({ trip: { id: 'recording' } });
    selected.resolve(full('selected', 'Selected snapshot'));
    await pendingSelected;

    expect(appState.activeTripId).toBe('selected');
    expect(appState.activeTripFull?.trip.name).toBe('Selected snapshot');
  });

  it('drops stale statistics after the active trip changes', async () => {
    const stats = deferred<{ distance: number; segments: never[] }>();
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Old trip');
    mocks.computeStatsAsync.mockReturnValueOnce(stats.promise);

    const pending = recalcNow();
    appState.activeTripId = 'b';
    appState.activeTripFull = full('b', 'New trip');
    stats.resolve({ distance: 10, segments: [] });

    await expect(pending).resolves.toBeNull();
    expect(appState.stats).toBeNull();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
  });
});
