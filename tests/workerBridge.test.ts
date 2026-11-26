import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDistanceSplits } from '../src/core/distanceSplits';

const EARTH_RADIUS = 6371008.8;
const segments = [{
  id: 'worker-fallback',
  points: [
    { lat: 0, lon: 0, t: 0 },
    { lat: 0, lon: (1500 / EARTH_RADIUS) * 180 / Math.PI, t: 750_000 }
  ]
}];
const expected = computeDistanceSplits(segments, 1000, { activity: 'hike' });

class MockWorker {
  static instances: MockWorker[] = [];
  static postError = false;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(() => {
    if (MockWorker.postError) throw new Error('post failed');
  });
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  MockWorker.instances = [];
  MockWorker.postError = false;
  vi.stubGlobal('Worker', MockWorker);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('compute worker resilience', () => {
  it('requests summary-only statistics for recorder recovery', async () => {
    const { computeStatsSummaryAsync } = await import('../src/core/workerBridge');
    const pending = computeStatsSummaryAsync(segments, { activity: 'hike' });
    const instance = MockWorker.instances[0];

    expect(instance.postMessage).toHaveBeenCalledWith({
      id: 1,
      type: 'stats',
      payload: { segments, opts: { activity: 'hike', series: false } }
    });
    instance.onmessage?.({ data: { id: 1, ok: true, result: { pointCount: 2 } } });

    await expect(pending).resolves.toEqual({ pointCount: 2 });
  });

  it('clears the timeout after a successful worker response', async () => {
    const { computeDistanceSplitsAsync } = await import('../src/core/workerBridge');
    const pending = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    const instance = MockWorker.instances[0];

    instance.onmessage?.({ data: { id: 1, ok: true, result: expected } });

    await expect(pending).resolves.toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    expect(instance.terminate).not.toHaveBeenCalled();
  });

  it('falls back and terminates after a runtime worker error', async () => {
    const { computeDistanceSplitsAsync } = await import('../src/core/workerBridge');
    const pending = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    const instance = MockWorker.instances[0];

    instance.onerror?.({ preventDefault: vi.fn() });

    await expect(pending).resolves.toEqual(expected);
    expect(instance.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const next = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    expect(MockWorker.instances).toHaveLength(2);
    MockWorker.instances[1].onmessage?.({ data: { id: 2, ok: true, result: expected } });
    await expect(next).resolves.toEqual(expected);
  });

  it('falls back for every pending task and replaces a hung worker', async () => {
    const { computeDistanceSplitsAsync } = await import('../src/core/workerBridge');
    const first = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    const second = computeDistanceSplitsAsync(segments, 500, { activity: 'hike' });
    const instance = MockWorker.instances[0];

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(computeDistanceSplits(segments, 500, { activity: 'hike' }));
    expect(instance.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    const next = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    expect(MockWorker.instances).toHaveLength(2);
    MockWorker.instances[1].onmessage?.({ data: { id: 3, ok: true, result: expected } });
    await expect(next).resolves.toEqual(expected);
  });

  it('falls back when posting a task fails', async () => {
    const { computeDistanceSplitsAsync } = await import('../src/core/workerBridge');
    MockWorker.postError = true;

    await expect(computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' })).resolves.toEqual(expected);
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a reported task error without leaving a timeout behind', async () => {
    const { computeDistanceSplitsAsync } = await import('../src/core/workerBridge');
    const pending = computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' });
    const instance = MockWorker.instances[0];

    instance.onmessage?.({ data: { id: 1, ok: false, error: 'invalid track' } });

    await expect(pending).rejects.toThrow('invalid track');
    expect(vi.getTimerCount()).toBe(0);
  });
});
