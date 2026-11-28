import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTrip: vi.fn(),
  getTrip: vi.fn(),
  addSegment: vi.fn(),
  updateTrip: vi.fn(),
  appendPoints: vi.fn(),
  pruneEmptySegments: vi.fn(),
  emit: vi.fn(),
  classifyActivityDetailed: vi.fn()
}));

vi.mock('../src/core/settings', () => ({
  get: vi.fn((key) => ({
    accuracyLimit: 65,
    ascentThreshold: 4,
    weightKg: 65,
    activity: 'auto',
    recordQuality: 'standard'
  })[key])
}));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('../src/core/i18n', () => ({ t: vi.fn((key) => key), currentLang: () => 'zh' }));
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
  resolveAltitude: vi.fn(async () => ({ alt: null }))
}));
vi.mock('../src/core/locks', () => ({
  acquireRecorderLock: vi.fn(async () => true),
  releaseRecorderLock: vi.fn(),
  broadcast: vi.fn(),
  isHolding: vi.fn(() => true)
}));
vi.mock('../src/core/wakelock', () => ({ requestWakeLock: vi.fn(), releaseWakeLock: vi.fn() }));
vi.mock('../src/core/keepalive', () => ({ armKeepAlive: vi.fn(), disarmKeepAlive: vi.fn() }));
vi.mock('../src/core/activity', () => ({
  ACTIVITY_CONFIDENCE_THRESHOLD: 0.56,
  classifyActivityDetailed: mocks.classifyActivityDetailed
}));
vi.mock('../src/core/storageKeys', () => ({ migrateLegacyKey: vi.fn() }));
vi.mock('../src/core/workerBridge', () => ({ computeStatsSummaryAsync: vi.fn() }));

const BASE_TIME = Date.UTC(2026, 0, 1, 12);

function classification(activity: 'bike' | null) {
  return {
    activity,
    confidence: activity ? 0.82 : 0.42,
    threshold: 0.56,
    lowConfidence: activity == null,
    candidates: [],
    reasons: [],
    features: {}
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installGlobals(navigatorValue: Record<string, unknown> = {}) {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' });
  vi.stubGlobal('navigator', { onLine: true, ...navigatorValue });
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() });
}

function fix(index: number, overrides: Record<string, unknown> = {}) {
  return {
    lat: 30 + index * 0.0001,
    lon: 120,
    t: Date.now(),
    acc: 5,
    alt: 100,
    altAcc: 5,
    speed: 1.3,
    ...overrides
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.createTrip.mockResolvedValue({ id: 'trip-1', activity: 'auto', status: 'recording' });
  mocks.getTrip.mockResolvedValue({ id: 'trip-1', activity: 'auto', status: 'recording' });
  mocks.addSegment.mockResolvedValue({ id: 'seg-1' });
  mocks.updateTrip.mockResolvedValue(undefined);
  mocks.appendPoints.mockResolvedValue(undefined);
  mocks.pruneEmptySegments.mockResolvedValue(undefined);
  mocks.classifyActivityDetailed.mockReturnValue(classification(null));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('recorder live quality and activity integration', () => {
  it('counts stationary deadband fixes as valid without persisting them as points', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.handleFix(fix(0));
    for (let i = 1; i < 6; i++) {
      vi.setSystemTime(BASE_TIME + i * 1000);
      await recorder.handleFix(fix(0, { lat: 30 + i * 0.00001, t: Date.now(), speed: 0 }));
    }

    expect(recorder.rec.live?.pointCount).toBe(1);
    expect(recorder.rec.quality).toMatchObject({
      observedFixes: 6, validFixes: 6, invalidFixes: 0, validRatio: 1,
      validSampleRatePerMin: 72, completeness: 1
    });
    expect(recorder.rec.quality?.lastValidFixAgeMs).toBe(0);
    await recorder.stopRecording();
  });

  it('does not count malformed, stale or poor-accuracy callbacks as valid', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.handleFix(fix(0));
    await recorder.handleFix(fix(0, { lat: null }));
    await recorder.handleFix(fix(0, { acc: 100, t: Date.now() + 1 }));
    await recorder.handleFix(fix(0, { t: Date.now() - 6000 }));

    expect(recorder.rec.quality).toMatchObject({
      observedFixes: 4, validFixes: 1, invalidFixes: 3, validRatio: 0.25
    });
    expect(recorder.rec.live?.pointCount).toBe(1);
    await recorder.stopRecording();
  });

  it('settles every pending filter count when a relocation is confirmed', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.handleFix(fix(0, { t: BASE_TIME }));
    vi.setSystemTime(BASE_TIME + 5_000);
    await recorder.handleFix(fix(0, { lat: 31, t: Date.now() }));
    vi.setSystemTime(BASE_TIME + 15_000);
    await recorder.handleFix(fix(0, { lat: 31.0001, t: Date.now() }));
    expect(recorder.rec.filteredCount).toBe(2);
    vi.setSystemTime(BASE_TIME + 25_000);
    await recorder.handleFix(fix(0, { lat: 31.0002, t: Date.now() }));

    expect(recorder.rec.filteredCount).toBe(0);
    expect(recorder.rec.live?.pointCount).toBe(4);
    expect(recorder.rec.quality).toMatchObject({ observedFixes: 4, validFixes: 4, invalidFixes: 0, validRatio: 1 });
    await recorder.stopRecording();
  });

  it('keeps discarded pending fixes filtered and invalid when the real track returns', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.handleFix(fix(0, { t: BASE_TIME }));
    vi.setSystemTime(BASE_TIME + 5_000);
    await recorder.handleFix(fix(0, { lat: 31, t: Date.now() }));
    vi.setSystemTime(BASE_TIME + 15_000);
    await recorder.handleFix(fix(0, { lat: 31.0001, t: Date.now() }));
    vi.setSystemTime(BASE_TIME + 25_000);
    await recorder.handleFix(fix(0, { lat: 30, t: Date.now() }));

    expect(recorder.rec.filteredCount).toBe(2);
    expect(recorder.rec.live?.pointCount).toBe(1);
    expect(recorder.rec.quality).toMatchObject({ observedFixes: 4, validFixes: 2, invalidFixes: 2, validRatio: 0.5 });
    await recorder.stopRecording();
  });

  it('retains the last confident guess when later evidence is low confidence', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    mocks.classifyActivityDetailed.mockReturnValue(classification('bike'));
    for (let i = 0; i < 10; i++) {
      vi.setSystemTime(BASE_TIME + i * 1000);
      await recorder.handleFix(fix(i));
    }
    expect(recorder.rec.tripActivity).toBe('auto');
    expect(recorder.rec.live?.pointCount).toBe(10);
    expect(recorder.rec.activityClassification).not.toBeNull();
    expect(recorder.rec.activityClassification?.activity).toBe('bike');
    expect(mocks.classifyActivityDetailed).toHaveBeenCalled();
    expect(recorder.rec.activityGuess).toBe('bike');

    mocks.classifyActivityDetailed.mockReturnValue(classification(null));
    for (let i = 10; i < 15; i++) {
      vi.setSystemTime(BASE_TIME + i * 1000);
      await recorder.handleFix(fix(i));
    }
    expect(recorder.rec.activityClassification?.lowConfidence).toBe(true);
    expect(recorder.rec.activityGuess).toBe('bike');
    await recorder.stopRecording();
    expect(mocks.updateTrip).toHaveBeenCalledWith('trip-1', { status: 'finished', activity: 'bike' });
  });

  it('leaves an auto trip auto when no classification is confident', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(BASE_TIME + i * 1000);
      await recorder.handleFix(fix(i));
    }
    expect(recorder.rec.activityGuess).toBeNull();
    await recorder.stopRecording();
    expect(mocks.updateTrip).toHaveBeenCalledWith('trip-1', { status: 'finished' });
  });

  it('keeps a manual activity authoritative at stop even if storage still says auto', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    recorder.setRecordingActivity('run');
    for (let i = 0; i < 6; i++) {
      vi.setSystemTime(BASE_TIME + i * 1000);
      await recorder.handleFix(fix(i));
    }
    expect(mocks.classifyActivityDetailed).not.toHaveBeenCalled();
    await recorder.stopRecording();
    expect(mocks.updateTrip).toHaveBeenCalledWith('trip-1', { status: 'finished', activity: 'run' });
  });

  it('removes battery listeners on pause and stop', async () => {
    const battery = {
      level: 0.5,
      charging: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    installGlobals({ getBattery: vi.fn(async () => battery) });
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await vi.advanceTimersByTimeAsync(0);
    expect(battery.addEventListener).toHaveBeenCalledTimes(2);
    expect(recorder.rec.quality?.battery).toMatchObject({ supported: true, level: 0.5, charging: false });

    await recorder.pauseRecording();
    expect(battery.removeEventListener).toHaveBeenCalledTimes(2);
    await recorder.resumeRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(battery.addEventListener).toHaveBeenCalledTimes(4);
    await recorder.stopRecording();
    expect(battery.removeEventListener).toHaveBeenCalledTimes(4);
  });

  it('ignores delayed battery readings from an older recording session', async () => {
    const oldBattery = deferred<any>();
    const oldMonitor = { level: 0.1, charging: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const currentMonitor = { level: 0.7, charging: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const getBattery = vi.fn()
      .mockImplementationOnce(() => oldBattery.promise)
      .mockResolvedValue(currentMonitor);
    installGlobals({ getBattery });
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.stopRecording();
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.rec.quality?.battery?.level).toBe(0.7);

    oldBattery.resolve(oldMonitor);
    await vi.advanceTimersByTimeAsync(0);
    expect(oldMonitor.addEventListener).not.toHaveBeenCalled();
    expect(recorder.rec.quality?.battery?.level).toBe(0.7);
    expect(recorder.rec.quality?.warnings.some((warning) => warning.code.startsWith('battery-'))).toBe(false);
    await recorder.stopRecording();
  });

  it('ignores delayed storage estimates from an older recording session', async () => {
    const oldEstimate = deferred<{ usage: number; quota: number }>();
    const estimate = vi.fn()
      .mockImplementationOnce(() => oldEstimate.promise)
      .mockResolvedValue({ usage: 100, quota: 1000 });
    installGlobals({ storage: { estimate } });
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.stopRecording();
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.rec.quality?.storage?.usage).toBe(100);

    oldEstimate.resolve({ usage: 950, quota: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.rec.quality?.storage?.usage).toBe(100);
    expect(recorder.rec.quality?.warnings.some((warning) => warning.code === 'storage-critical')).toBe(false);
    await recorder.stopRecording();
  });

  it('excludes paused time from completeness across resume', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.handleFix(fix(0));
    vi.setSystemTime(BASE_TIME + 30_000);
    await recorder.handleFix(fix(1));
    await recorder.pauseRecording();

    vi.setSystemTime(BASE_TIME + 90_000);
    await recorder.resumeRecording();
    vi.setSystemTime(BASE_TIME + 95_000);
    await recorder.handleFix(fix(2));
    expect(recorder.rec.quality).toMatchObject({
      activeDurationMs: 35_000, validSpanMs: 35_000, completeness: 1,
      trackSpanMs: 35_000, trackCompleteness: 1
    });
    await recorder.stopRecording();
  });

  it('does not warn about missing GPS until the resumed segment has waited long enough', async () => {
    installGlobals();
    const recorder = await import('../src/core/recorder');
    await recorder.startRecording({ simulated: true, activity: 'auto' });
    await recorder.pauseRecording();
    vi.setSystemTime(BASE_TIME + 120_000);
    await recorder.resumeRecording();
    expect(recorder.rec.quality?.warnings.some((warning) => warning.code === 'gps-no-fix')).toBe(false);

    vi.setSystemTime(BASE_TIME + 141_000);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(recorder.rec.quality?.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'gps-no-fix', action: 'retry-location' })
    ]));
    await recorder.stopRecording();
  });
});
