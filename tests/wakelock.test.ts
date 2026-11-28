// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/settings', () => ({ get: vi.fn(() => true) }));
vi.mock('../src/core/events', () => ({ emit: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function createSentinel() {
  let releaseListener: (() => void) | null = null;
  return {
    release: vi.fn(async () => {}),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'release') releaseListener = listener;
    }),
    dispatchRelease: () => releaseListener?.()
  };
}

let wakelock: typeof import('../src/core/wakelock');

beforeEach(async () => {
  vi.resetModules();
  wakelock = await import('../src/core/wakelock');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('screen wake lock races', () => {
  it('releases an acquisition that settles after a pending release', async () => {
    const pending = deferred<ReturnType<typeof createSentinel>>();
    const first = createSentinel();
    const second = createSentinel();
    const request = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(second);
    vi.stubGlobal('navigator', { wakeLock: { request } });

    const acquiring = wakelock.requestWakeLock();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const releasing = wakelock.releaseWakeLock();
    pending.resolve(first);

    await expect(acquiring).resolves.toBe(false);
    await releasing;
    expect(first.release).toHaveBeenCalledTimes(1);

    await expect(wakelock.requestWakeLock()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    await wakelock.releaseWakeLock();
    expect(second.release).toHaveBeenCalledTimes(1);
  });

  it('finishes an older release before starting a newer acquisition', async () => {
    const first = createSentinel();
    const second = createSentinel();
    const pendingRelease = deferred<void>();
    first.release.mockReturnValue(pendingRelease.promise);
    const request = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.stubGlobal('navigator', { wakeLock: { request } });

    await expect(wakelock.requestWakeLock()).resolves.toBe(true);
    const releasing = wakelock.releaseWakeLock();
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledTimes(1));
    const reacquiring = wakelock.requestWakeLock();
    expect(request).toHaveBeenCalledTimes(1);

    pendingRelease.resolve();
    await releasing;
    await expect(reacquiring).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    await wakelock.releaseWakeLock();
  });

  it('ignores a stale release event from an older sentinel', async () => {
    const first = createSentinel();
    const second = createSentinel();
    const request = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    vi.stubGlobal('navigator', { wakeLock: { request } });

    await wakelock.requestWakeLock();
    await wakelock.releaseWakeLock();
    await wakelock.requestWakeLock();
    first.dispatchRelease();

    await expect(wakelock.requestWakeLock()).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    await wakelock.releaseWakeLock();
    expect(second.release).toHaveBeenCalledTimes(1);
  });
});
