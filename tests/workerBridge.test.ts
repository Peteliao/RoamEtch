import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDistanceSplits } from '../src/core/distanceSplits';
import { previewTrackCleanup } from '../src/core/gpsQuality';
import { compareTracks } from '../src/core/trackComparison';
import { decodeWorkerPayload, prepareWorkerPayload } from '../src/core/workerPayload';

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
  postMessage = vi.fn((_message: any, _transferList?: Transferable[]) => {
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

describe('worker payload codec', () => {
  it('round-trips nullable fields and excludes media from large GPX payloads', () => {
    const first = { lat: 30, lon: 120, alt: null, altSrc: null, acc: null, speed: null, synth: false, custom: 'kept' };
    const typical = { lat: 30.001, lon: 120.001, alt: 100, t: 123, altSrc: 'svc', acc: 5, speed: 1.2 };
    const points = Array.from({ length: 100_001 }, (_, index) => index === 0 ? first : typical);
    const full = {
      trip: { id: 'trip', name: 'Large' },
      segments: [{ id: 'segment', index: 0, points }],
      waypoints: [],
      media: [{ blob: new Blob(['not sent to the worker']) }]
    };

    const wire = prepareWorkerPayload('gpx', { full });
    const decoded = decodeWorkerPayload(wire.payload);

    expect(wire.pointCount).toBe(points.length);
    expect(wire.payload.full).not.toHaveProperty('media');
    expect(decoded.full.segments[0].points).toHaveLength(points.length);
    expect(decoded.full.segments[0].points[0]).toEqual(first);
    expect(decoded.full.segments[0].points[1]).toEqual(typical);
    expect(decoded.full.segments[0].points.at(-1)).toEqual(typical);
  });
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

  it('keeps a large statistics task alive past the small-task timeout', async () => {
    const { computeStatsAsync } = await import('../src/core/workerBridge');
    const largeSegments = [{ points: { length: 100_001 } }];
    const pending = computeStatsAsync(largeSegments as any, {});
    const instance = MockWorker.instances[0];

    await vi.advanceTimersByTimeAsync(15_000);

    expect(instance.terminate).not.toHaveBeenCalled();
    instance.onmessage?.({ data: { id: 1, ok: true, result: { pointCount: 100_001 } } });
    await expect(pending).resolves.toEqual({ pointCount: 100_001 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transfers large worker payloads as columnar typed arrays', async () => {
    const { simplifyAsync } = await import('../src/core/workerBridge');
    const { decodeWorkerPayload } = await import('../src/core/workerPayload');
    const points = Array.from({ length: 100_001 }, (_, index) => ({ lat: 30, lon: 120 + index / 1_000_000, t: index }));
    const pending = simplifyAsync(points, 5);
    const instance = MockWorker.instances[0];
    const [message, transferList] = instance.postMessage.mock.calls[0];

    expect(message.pointCount).toBe(points.length);
    expect(message.payload.points.columns).toHaveLength(11);
    expect(message.payload.codec).toBe('columns-v1');
    expect(transferList.length).toBeGreaterThan(0);
    expect(transferList.every((value: any) => value instanceof ArrayBuffer)).toBe(true);
    const decoded = decodeWorkerPayload(message.payload);
    expect(decoded.points).toHaveLength(points.length);
    expect(decoded.points[0]).toEqual(points[0]);
    expect(decoded.points.at(-1)).toEqual(points.at(-1));

    instance.onmessage?.({ data: { id: 1, ok: true, result: [points[0], points.at(-1)] } });
    await expect(pending).resolves.toEqual([points[0], points.at(-1)]);
  });

  it('serializes GPX in the worker and returns the complete document', async () => {
    const { buildGPXAsync } = await import('../src/core/workerBridge');
    const full = { trip: { name: 'Worker GPX', createdAt: 0 }, segments: [], waypoints: [] };
    const pending = buildGPXAsync(full);
    const instance = MockWorker.instances[0];

    expect(instance.postMessage).toHaveBeenCalledWith({ id: 1, type: 'gpx', payload: { full } });
    instance.onmessage?.({ data: { id: 1, ok: true, result: '<gpx>complete</gpx>' } });

    await expect(pending).resolves.toBe('<gpx>complete</gpx>');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('builds a heatmap in the worker and falls back with matching semantics', async () => {
    const { buildHeatmapAsync } = await import('../src/core/workerBridge');
    const { buildHeatmap } = await import('../src/core/heatmap');
    const trips = [{ trip: { id: 'heat', privacy: { radius: 0 } }, segments }];
    const result = buildHeatmap(trips, { maxPoints: 21 });
    const pending = buildHeatmapAsync(trips, { maxPoints: 21 });
    const instance = MockWorker.instances[0];

    expect(instance.postMessage).toHaveBeenCalledWith({ id: 1, type: 'heatmap', payload: { trips, opts: { maxPoints: 21 } } });
    instance.onmessage?.({ data: { id: 1, ok: true, result } });
    await expect(pending).resolves.toEqual(result);
    expect(instance.terminate).not.toHaveBeenCalled();

    instance.onerror?.({ preventDefault: vi.fn() });
    vi.stubGlobal('Worker', class { constructor() { throw new Error('workers unavailable'); } });
    await expect(buildHeatmapAsync(trips, { maxPoints: 21 })).resolves.toEqual(result);
  });

  it('compares full tracks in an isolated worker and falls back with matching semantics', async () => {
    const { compareTracksAsync } = await import('../src/core/workerBridge');
    const a = { id: 'a', name: 'A', segments };
    const b = { id: 'b', name: 'B', segments };
    const expected = compareTracks(a, b, { sampleSpacingM: 25, maxSamples: 100 });
    const controller = new AbortController();
    const pending = compareTracksAsync(a, b, { sampleSpacingM: 25, maxSamples: 100, signal: controller.signal });
    const instance = MockWorker.instances[0];

    expect(instance.postMessage).toHaveBeenCalledWith({
      id: 1, type: 'track-comparison',
      payload: { a, b, opts: { sampleSpacingM: 25, maxSamples: 100 } }
    });
    instance.onmessage?.({ data: { id: 1, ok: true, result: expected } });
    await expect(pending).resolves.toEqual(expected);
    expect(instance.terminate).toHaveBeenCalledTimes(1);

    vi.stubGlobal('Worker', class { constructor() { throw new Error('workers unavailable'); } });
    await expect(compareTracksAsync(a, b, { sampleSpacingM: 25, maxSamples: 100 })).resolves.toEqual(expected);
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

  it('does not dispatch a task when its signal is already aborted', async () => {
    const { previewTrackCleanupAsync } = await import('../src/core/workerBridge');
    const controller = new AbortController();
    controller.abort();

    await expect(previewTrackCleanupAsync(segments, 'hike', {}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('releases an isolated cancellable worker after a successful response', async () => {
    const { previewTrackCleanupAsync } = await import('../src/core/workerBridge');
    const controller = new AbortController();
    const pending = previewTrackCleanupAsync(segments, 'hike', {}, { signal: controller.signal });
    const instance = MockWorker.instances[0];

    instance.onmessage?.({ data: { id: 1, ok: true, result: { removed: 0 } } });

    await expect(pending).resolves.toEqual({ removed: 0 });
    expect(instance.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates a blocked worker on cancellation and ignores its late response', async () => {
    const { previewTrackCleanupAsync } = await import('../src/core/workerBridge');
    const controller = new AbortController();
    const pending = previewTrackCleanupAsync(segments, 'hike', {}, { signal: controller.signal });
    const instance = MockWorker.instances[0];

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(instance.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    instance.onmessage?.({ data: { id: 1, ok: true, result: { removed: 99 } } });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);

    const next = previewTrackCleanupAsync(segments, 'hike');
    expect(MockWorker.instances).toHaveLength(2);
    MockWorker.instances[1].onmessage?.({ data: { id: 2, ok: true, result: { removed: 0 } } });
    await expect(next).resolves.toEqual({ removed: 0 });
  });

  it('keeps unrelated tasks in their worker when another task is cancelled', async () => {
    const { computeDistanceSplitsAsync, previewTrackCleanupAsync } = await import('../src/core/workerBridge');
    const controller = new AbortController();
    const cancelled = previewTrackCleanupAsync(segments, 'hike', {}, { signal: controller.signal });
    const other = computeDistanceSplitsAsync(segments, 500, { activity: 'hike' });
    const cancelledWorker = MockWorker.instances[0];
    const otherWorker = MockWorker.instances[1];

    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelledWorker.terminate).toHaveBeenCalledTimes(1);
    expect(otherWorker.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    otherWorker.onmessage?.({ data: { id: 2, ok: true, result: computeDistanceSplits(segments, 500, { activity: 'hike' }) } });
    await expect(other).resolves.toEqual(computeDistanceSplits(segments, 500, { activity: 'hike' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the lightweight cleanup fallback when workers are unavailable', async () => {
    vi.stubGlobal('Worker', class {
      constructor() { throw new Error('workers unavailable'); }
    });
    const { previewTrackCleanupAsync } = await import('../src/core/workerBridge');

    await expect(previewTrackCleanupAsync(segments, 'hike')).resolves.toEqual(
      previewTrackCleanup(segments, 'hike')
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an unavailable-worker fallback after synchronous cancellation', async () => {
    vi.stubGlobal('Worker', class {
      constructor() { throw new Error('workers unavailable'); }
    });
    const { previewTrackCleanupAsync } = await import('../src/core/workerBridge');
    const controller = new AbortController();
    const pending = previewTrackCleanupAsync(segments, 'hike', {}, { signal: controller.signal });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
