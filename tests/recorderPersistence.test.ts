import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTrip: vi.fn(),
  getTrip: vi.fn(),
  addSegment: vi.fn(),
  updateTrip: vi.fn(),
  appendPoints: vi.fn(),
  pruneEmptySegments: vi.fn(),
  emit: vi.fn()
}));

vi.mock('../src/core/settings', () => ({
  get: vi.fn((key) => ({
    accuracyLimit: 65,
    ascentThreshold: 4,
    weightKg: 65,
    activity: 'hike',
    recordQuality: 'standard'
  })[key])
}));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/i18n', () => ({ t: vi.fn((key) => key) }));
vi.mock('../src/core/store', () => ({
  createTrip: mocks.createTrip,
  getTrip: mocks.getTrip,
  addSegment: mocks.addSegment,
  updateTrip: mocks.updateTrip,
  appendPoints: mocks.appendPoints,
  pruneEmptySegments: mocks.pruneEmptySegments,
  countTripSegments: async () => 1
}));
vi.mock('../src/core/elevation', () => ({
  patchFlushedAltitude: vi.fn(),
  resolveAltitude: vi.fn()
}));
vi.mock('../src/core/locks', () => ({
  acquireRecorderLock: vi.fn(async () => true),
  releaseRecorderLock: vi.fn(),
  broadcast: vi.fn(),
  isHolding: vi.fn(() => true)
}));
vi.mock('../src/core/wakelock', () => ({ requestWakeLock: vi.fn(), releaseWakeLock: vi.fn() }));
vi.mock('../src/core/keepalive', () => ({ armKeepAlive: vi.fn(), disarmKeepAlive: vi.fn() }));
vi.mock('../src/core/storageKeys', () => ({ migrateLegacyKey: vi.fn() }));
vi.mock('../src/core/workerBridge', () => ({ computeStatsSummaryAsync: vi.fn() }));

const SPILL_KEY = 'roametch.pendingPoints.v1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function installGlobals() {
  const listeners = new Map<string, () => void>();
  const values = new Map<string, string>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener)
  });
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    visibilityState: 'visible'
  });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal('setInterval', vi.fn(() => 1));
  vi.stubGlobal('clearInterval', vi.fn());
  return { listeners, values };
}

function fix(index: number) {
  const start = Date.now();
  return {
    lat: 30 + index * 0.00006,
    lon: 120,
    t: start + index * 1000,
    acc: 5,
    alt: 100 + index * 0.01,
    altAcc: 5,
    speed: 6.5
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.createTrip.mockResolvedValue({ id: 'trip-1', activity: 'hike', status: 'recording' });
  mocks.getTrip.mockResolvedValue({ id: 'trip-1', activity: 'hike', status: 'recording' });
  mocks.addSegment.mockResolvedValue({ id: 'seg-1' });
  mocks.updateTrip.mockResolvedValue(undefined);
  mocks.appendPoints.mockResolvedValue(undefined);
  mocks.pruneEmptySegments.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('recorder persistence bounds', () => {
  it('keeps the pagehide spill until both in-flight and buffered batches are durable', async () => {
    const { listeners, values } = installGlobals();
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.appendPoints
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true });

    for (let i = 0; i < 10; i++) await recorder.handleFix(fix(i));
    await vi.waitFor(() => expect(mocks.appendPoints).toHaveBeenCalledTimes(1));
    for (let i = 10; i < 15; i++) await recorder.handleFix(fix(i));

    listeners.get('pagehide')?.();
    expect(JSON.parse(values.get(SPILL_KEY)!).points).toHaveLength(15);

    first.resolve();
    await vi.waitFor(() => expect(mocks.appendPoints).toHaveBeenCalledTimes(2));
    expect(values.has(SPILL_KEY)).toBe(true);

    second.reject(new Error('quota'));
    await expect(recorder.flushBuffer()).resolves.toBe(false);
    expect(values.has(SPILL_KEY)).toBe(true);
    expect(recorder.rec.saveState).toMatchObject({ pending: 5, error: 'write', degraded: false });

    await expect(recorder.flushBuffer()).resolves.toBe(true);
    expect(values.has(SPILL_KEY)).toBe(false);
    await recorder.stopRecording();
  });

  it('coalesces flush requests and pauses new fixes at the pending limit', async () => {
    installGlobals();
    const first = deferred<void>();
    mocks.appendPoints.mockImplementationOnce(() => first.promise);
    const recorder = await import('../src/core/recorder');
    const { MAX_PENDING_POINTS } = recorder;
    await recorder.startRecording({ simulated: true });

    for (let i = 0; i < 10; i++) await recorder.handleFix(fix(i));
    await vi.waitFor(() => expect(mocks.appendPoints).toHaveBeenCalledTimes(1));
    for (let i = 10; i < MAX_PENDING_POINTS; i++) await recorder.handleFix(fix(i));

    expect(mocks.appendPoints).toHaveBeenCalledTimes(1);
    expect(recorder.rec.saveState.pending).toBe(MAX_PENDING_POINTS);
    await recorder.handleFix(fix(MAX_PENDING_POINTS));

    expect(recorder.rec.live.pointCount).toBe(MAX_PENDING_POINTS);
    expect(recorder.rec.saveState).toMatchObject({
      pending: MAX_PENDING_POINTS,
      error: 'capacity',
      degraded: true
    });
    expect(recorder.rec.quality?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'storage-capacity', action: 'retry-save' })
    ]));
    expect(mocks.emit).toHaveBeenCalledWith('recorder:saveerror', {
      error: 'capacity',
      pending: MAX_PENDING_POINTS
    });

    first.resolve();
    await expect(recorder.flushBuffer()).resolves.toBe(true);
    expect(mocks.appendPoints).toHaveBeenCalledTimes(2);
    expect(recorder.rec.saveState).toMatchObject({ pending: 0, error: null, degraded: false });
    await recorder.stopRecording();
  }, 30_000);
});
