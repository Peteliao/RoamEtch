import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTrip: vi.fn(),
  loadTripTrack: vi.fn(),
  loadTripFull: vi.fn(),
  acquireRecorderLock: vi.fn(),
  releaseRecorderLock: vi.fn(),
  computeStatsSummaryAsync: vi.fn()
}));

vi.mock('../src/core/settings', () => ({ get: vi.fn((key) => key === 'ascentThreshold' ? 4 : 65) }));
vi.mock('../src/core/events', () => ({ emit: vi.fn() }));
vi.mock('../src/core/i18n', () => ({ t: vi.fn((key) => key) }));
vi.mock('../src/core/store', () => ({
  getTrip: mocks.getTrip,
  loadTripTrack: mocks.loadTripTrack,
  loadTripFull: mocks.loadTripFull
}));
vi.mock('../src/core/elevation', () => ({ patchFlushedAltitude: vi.fn(), resolveAltitude: vi.fn() }));
vi.mock('../src/core/locks', () => ({
  acquireRecorderLock: mocks.acquireRecorderLock,
  releaseRecorderLock: mocks.releaseRecorderLock,
  broadcast: vi.fn(),
  isHolding: vi.fn(() => true)
}));
vi.mock('../src/core/wakelock', () => ({ requestWakeLock: vi.fn(), releaseWakeLock: vi.fn() }));
vi.mock('../src/core/keepalive', () => ({ armKeepAlive: vi.fn(), disarmKeepAlive: vi.fn() }));
vi.mock('../src/core/activity', () => ({ classifyActivity: vi.fn(() => 'hike') }));
vi.mock('../src/core/storageKeys', () => ({ migrateLegacyKey: vi.fn() }));
vi.mock('../src/core/workerBridge', () => ({ computeStatsSummaryAsync: mocks.computeStatsSummaryAsync }));

afterEach(() => vi.unstubAllGlobals());

describe('interrupted trip recovery', () => {
  it('loads track-only data and rebuilds counters through the worker bridge', async () => {
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' });
    vi.stubGlobal('navigator', {});
    const lastPoint = { lat: 30.002, lon: 120, alt: 120, t: 180_000 };
    const segments = [{ id: 'seg-1', points: [lastPoint] }];
    mocks.getTrip.mockResolvedValue({ id: 'trip-1', activity: 'hike' });
    mocks.loadTripTrack.mockResolvedValue({ trip: { id: 'trip-1' }, segments });
    mocks.acquireRecorderLock.mockResolvedValue(true);
    mocks.computeStatsSummaryAsync.mockResolvedValue({
      distance: 222,
      ascent: 20,
      descent: 8,
      activeMs: 180_000,
      movingMs: 180_000,
      stillMs: 0,
      duration: 180_000,
      pointCount: 1,
      segCount: 1,
      maxSpeed: 1.2
    });

    const { continueTrip, rec } = await import('../src/core/recorder');
    await expect(continueTrip('trip-1')).resolves.toBe(false);

    expect(mocks.loadTripTrack).toHaveBeenCalledWith('trip-1');
    expect(mocks.loadTripFull).not.toHaveBeenCalled();
    expect(mocks.computeStatsSummaryAsync).toHaveBeenCalledWith(segments, {
      ascentThreshold: 4,
      activity: 'hike',
      weightKg: 65
    });
    expect(rec.live).toMatchObject({ distance: 222, ascent: 20, pointCount: 1, segCount: 1 });
    expect(rec.lastPoint).toBe(lastPoint);
    expect(mocks.releaseRecorderLock).toHaveBeenCalled();
  });
});
