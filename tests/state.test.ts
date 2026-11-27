import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTripFull: vi.fn(),
  updateTrip: vi.fn(),
  cacheTripStats: vi.fn(),
  computeStatsAsync: vi.fn(),
  emit: vi.fn(),
  set: vi.fn(),
  backfillTripAltitudes: vi.fn()
}));

vi.mock('../src/core/store', () => ({
  loadTripFull: mocks.loadTripFull,
  updateTrip: mocks.updateTrip,
  cacheTripStats: mocks.cacheTripStats
}));
vi.mock('../src/core/workerBridge', () => ({ computeStatsAsync: mocks.computeStatsAsync }));
vi.mock('../src/core/settings', () => ({
  get: (key: string) => ({ ascentThreshold: 4, weightKg: 70 }[key]),
  set: mocks.set
}));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/elevation', () => ({ backfillTripAltitudes: mocks.backfillTripAltitudes }));

import { clearHistory, pushAction, undo } from '../src/core/history';
import {
  appState, cancelAltBackfill, isTripSectionActive, recalcNow, refreshActiveTrip,
  scheduleAltBackfill, scheduleRecalc, setActiveTrip
} from '../src/ui/state';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function full(id: string, name: string, activity = 'hike', reportedDistance: number | null = null) {
  return {
    trip: { id, name, activity, reportedDistance, statsCache: null, updatedAt: 1 },
    segments: [{ id: `${id}-segment`, points: [] }],
    waypoints: [],
    media: []
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelAltBackfill();
  clearHistory();
  vi.clearAllMocks();
  appState.view = 'record';
  appState.activeTripId = null;
  appState.activeTripFull = null;
  appState.tripSession = 0;
  appState.stats = null;
  appState.tripDetail = { open: false, tripId: null, section: 'overview' };
  mocks.updateTrip.mockResolvedValue(undefined);
  mocks.cacheTripStats.mockResolvedValue(true);
  mocks.computeStatsAsync.mockResolvedValue({ distance: 1, segments: [] });
});

afterEach(() => {
  cancelAltBackfill();
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

  it('does not execute an old session action after a rapid A-to-B-to-A selection', async () => {
    const firstA = deferred<ReturnType<typeof full>>();
    const b = deferred<ReturnType<typeof full>>();
    const secondA = deferred<ReturnType<typeof full>>();
    mocks.loadTripFull.mockReturnValueOnce(firstA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(secondA.promise);

    const pendingFirstA = setActiveTrip('a');
    const oldSession = appState.tripSession;
    const oldAction = {
      label: 'old-a-edit', tripId: 'a', session: oldSession,
      undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn()
    };
    pushAction(oldAction);
    const pendingB = setActiveTrip('b');
    const pendingSecondA = setActiveTrip('a');
    const currentSession = appState.tripSession;
    expect(currentSession).toBe(oldSession + 2);

    secondA.resolve(full('a', 'Newest A'));
    await pendingSecondA;
    b.resolve(full('b', 'B'));
    firstA.resolve(full('a', 'Old A'));
    await Promise.all([pendingFirstA, pendingB]);

    expect(appState.activeTripId).toBe('a');
    expect(appState.activeTripFull?.trip.name).toBe('Newest A');
    expect(mocks.computeStatsAsync).toHaveBeenCalledTimes(1);
    await expect(undo({ tripId: 'a', session: currentSession })).resolves.toBe(false);
    expect(oldAction.undo).not.toHaveBeenCalled();
    expect(oldAction.redo).not.toHaveBeenCalled();
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

  it('refreshes an unchanged activity without replacing statistics or scheduling recalculation', async () => {
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Before');
    const cached = { distance: 12, calories: 34 };
    appState.stats = cached;
    scheduleRecalc();
    mocks.loadTripFull.mockResolvedValueOnce(full('a', 'After'));

    await expect(refreshActiveTrip('a', { recalc: false })).resolves.toMatchObject({ trip: { name: 'After' } });
    await vi.advanceTimersByTimeAsync(350);

    expect(appState.stats).toBe(cached);
    expect(mocks.computeStatsAsync).not.toHaveBeenCalled();
    expect(mocks.updateTrip).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith('trip:active', expect.objectContaining({ trip: expect.objectContaining({ name: 'After' }) }));
  });

  it('reuses the active track for a metadata-only refresh', async () => {
    appState.activeTripId = 'a';
    const previous = full('a', 'Before');
    appState.activeTripFull = previous;
    const next = full('a', 'After');
    next.trip.updatedAt = 2;
    mocks.loadTripFull.mockResolvedValueOnce(next);

    await refreshActiveTrip('a', { recalc: false, metadataOnly: true });

    expect(mocks.loadTripFull).toHaveBeenCalledWith('a', {
      trackSnapshot: previous,
      trackUnchanged: true
    });
  });

  it('drops stale in-memory statistics before publishing a changed activity', async () => {
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Before', 'drive');
    appState.stats = { distance: 500, calories: null };
    const next = full('a', 'After', 'hike');
    next.trip.statsCache = null;
    mocks.loadTripFull.mockResolvedValueOnce(next);

    await refreshActiveTrip('a', { recalc: false });

    expect(appState.stats).toBeNull();
    expect(mocks.emit).toHaveBeenCalledWith('trip:active', next);
    expect(mocks.computeStatsAsync).not.toHaveBeenCalled();
  });

  it('cancels a pending debounce when an activity edit recalculates immediately', async () => {
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Trip', 'hike');
    scheduleRecalc();

    await recalcNow();
    await vi.advanceTimersByTimeAsync(350);

    expect(mocks.computeStatsAsync).toHaveBeenCalledTimes(1);
  });

  it('reuses completed statistics until the track version or metric inputs change', async () => {
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Trip');

    const first = await recalcNow();
    await expect(recalcNow()).resolves.toBe(first);
    expect(mocks.computeStatsAsync).toHaveBeenCalledTimes(1);

    appState.activeTripFull = full('a', 'Edited trip');
    appState.activeTripFull.trip.updatedAt = 2;
    await recalcNow();
    expect(mocks.computeStatsAsync).toHaveBeenCalledTimes(2);
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

  it('does not cache or publish statistics when the track changed during calculation', async () => {
    const stats = deferred<{ distance: number; segments: never[] }>();
    appState.activeTripId = 'a';
    appState.activeTripFull = full('a', 'Before edit');
    mocks.computeStatsAsync.mockReturnValueOnce(stats.promise);
    mocks.cacheTripStats.mockResolvedValueOnce(false);

    const pending = recalcNow();
    appState.activeTripFull = full('a', 'After edit');
    stats.resolve({ distance: 10, segments: [] });

    await expect(pending).resolves.toBeNull();
    expect(mocks.cacheTripStats).toHaveBeenCalledWith('a', 1, expect.objectContaining({ distance: 10 }));
    expect(appState.stats).toBeNull();
    expect(mocks.emit).not.toHaveBeenCalledWith('trip:stats', expect.anything());
  });
});

describe('altitude backfill cancellation', () => {
  it('cancels a scheduled backfill when the active trip changes', async () => {
    appState.activeTripId = 'a';
    mocks.loadTripFull.mockResolvedValueOnce(full('b', 'Next trip'));
    scheduleAltBackfill('a');
    await vi.advanceTimersByTimeAsync(799);

    await setActiveTrip('b');
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.backfillTripAltitudes).not.toHaveBeenCalled();
  });

  it('cancels a scheduled backfill when leaving the view', async () => {
    appState.activeTripId = 'a';
    scheduleAltBackfill('a');
    await vi.advanceTimersByTimeAsync(799);

    cancelAltBackfill();
    await vi.advanceTimersByTimeAsync(1);

    expect(mocks.backfillTripAltitudes).not.toHaveBeenCalled();
  });

  it('aborts an in-flight backfill and ignores its result after the active trip changes', async () => {
    const filled = deferred<number>();
    appState.activeTripId = 'a';
    mocks.backfillTripAltitudes.mockReturnValueOnce(filled.promise);
    scheduleAltBackfill('a');
    vi.advanceTimersByTime(800);
    const signal = mocks.backfillTripAltitudes.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    mocks.loadTripFull.mockResolvedValueOnce(full('b', 'Next trip'));

    await setActiveTrip('b');
    expect(signal.aborted).toBe(true);
    filled.resolve(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.loadTripFull).toHaveBeenCalledTimes(1);
    expect(mocks.loadTripFull).toHaveBeenCalledWith('b');
    expect(mocks.emit).not.toHaveBeenCalledWith('toast', expect.anything());
  });

  it('aborts an in-flight backfill and ignores its result when leaving the view', async () => {
    const filled = deferred<number>();
    appState.activeTripId = 'a';
    mocks.backfillTripAltitudes.mockReturnValueOnce(filled.promise);
    scheduleAltBackfill('a');
    vi.advanceTimersByTime(800);
    const signal = mocks.backfillTripAltitudes.mock.calls[0][1].signal as AbortSignal;

    cancelAltBackfill();
    expect(signal.aborted).toBe(true);
    filled.resolve(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.loadTripFull).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalledWith('toast', expect.anything());
  });
});
