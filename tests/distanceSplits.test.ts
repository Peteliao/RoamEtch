import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeDistanceSplits } from '../src/core/distanceSplits';
import { computeDistanceSplitsAsync } from '../src/core/workerBridge';

const EARTH_RADIUS = 6371008.8;

function at(distance: number, t: number | null = 0, alt: number | null = 0, extra: any = {}) {
  return {
    lat: 0,
    lon: (distance / EARTH_RADIUS) * 180 / Math.PI,
    t,
    alt,
    ...extra
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

afterEach(() => vi.unstubAllGlobals());

describe('fixed-distance splits', () => {
  it('interpolates exact boundaries in distance, time, and altitude', () => {
    const splits = computeDistanceSplits([{
      id: 'track',
      points: [at(0, 0, 100), at(1500, 750_000, 160)]
    }], 1000, { activity: 'hike' });

    expect(splits).toHaveLength(2);
    const [full, partial] = splits;
    expect(full).toMatchObject({
      index: 0,
      distance: 1000,
      duration: 500_000,
      activeMs: 0,
      movingMs: 0,
      avgSpeed: 0,
      maxSpeed: 2,
      pointCount: 2,
      partial: false,
      startDistance: 0,
      endDistance: 1000
    });
    expect(full.parts).toHaveLength(1);
    expect(full.parts[0]).toMatchObject({ segmentId: 'track', segmentIndex: 0, startDistance: 0, endDistance: 1000 });
    expect(full.parts[0].points[1].lat).toBeCloseTo(0, 12);
    expect(full.parts[0].points[1].lon).toBeCloseTo(at(1000).lon, 12);
    expect(full.parts[0].points[1].t).toBeCloseTo(500_000, 6);
    expect(full.parts[0].points[1].alt).toBeCloseTo(140, 6);
    expect(full.ascent).toBeGreaterThan(0);

    expect(partial).toMatchObject({
      index: 1,
      duration: 250_000,
      activeMs: 0,
      movingMs: 0,
      avgSpeed: 0,
      maxSpeed: 2,
      pointCount: 2,
      partial: true,
      startDistance: 1000
    });
    expect(partial.distance).toBeCloseTo(500, 6);
    expect(partial.endDistance).toBeCloseTo(1500, 6);
    expect(partial.parts[0].points[0].t).toBeCloseTo(500_000, 6);
    expect(partial.parts[0].points[1].alt).toBe(160);
  });

  it('emits every boundary when one step spans multiple intervals', () => {
    const splits = computeDistanceSplits([{
      id: 'long-step',
      points: [at(0, 0), at(2500, 1_250_000)]
    }], 1000);

    expect(splits.map((split) => split.distance)).toEqual([1000, 1000, 500]);
    splits.forEach((split, i) => {
      expect(split.duration).toBeCloseTo([500_000, 500_000, 250_000][i], 6);
      expect(split.parts[0].points[1].t).toBeCloseTo([500_000, 1_000_000, 1_250_000][i], 6);
    });
    expect(splits.map((split) => split.partial)).toEqual([false, false, true]);
    expect(splits.reduce((sum, split) => sum + split.activeMs, 0)).toBe(0);
    expect(splits.every((split) => split.pointCount === 2)).toBe(true);
  });

  it('accumulates globally across segments without bridging their geographic gaps', () => {
    const splits = computeDistanceSplits([
      { id: 'a', points: [at(0, 0, 100), at(600, 300_000, 110)] },
      { id: 'b', points: [at(10_000, 600_000, 200), at(10_600, 900_000, 210)] }
    ], 1000);

    expect(splits).toHaveLength(2);
    const [full, partial] = splits;
    expect(full.distance).toBe(1000);
    expect(full.duration).toBeCloseTo(800_000, 6); // includes the 300 s recording pause
    expect(full.activeMs).toBe(0);
    expect(full.movingMs).toBe(0);
    expect(full.avgSpeed).toBe(0);
    expect(full.pointCount).toBe(4);
    expect(full.parts).toHaveLength(2);
    expect(full.parts[0]).toMatchObject({ segmentId: 'a', segmentIndex: 0 });
    expect(full.parts[0].startDistance).toBe(0);
    expect(full.parts[0].endDistance).toBeCloseTo(600, 6);
    expect(full.parts[1]).toMatchObject({ segmentId: 'b', segmentIndex: 1 });
    expect(full.parts[1].startDistance).toBeCloseTo(600, 6);
    expect(full.parts[1].endDistance).toBe(1000);
    expect(full.parts[0].points.at(-1)!.lon).not.toBe(full.parts[1].points[0].lon);
    expect(full.ascent).toBeLessThan(20); // no artificial climb across the gap

    expect(partial.distance).toBeCloseTo(200, 6);
    expect(partial.duration).toBeCloseTo(100_000, 6);
    expect(partial.activeMs).toBe(0);
    expect(partial.parts).toHaveLength(1);
    expect(partial.parts[0]).toMatchObject({ segmentId: 'b', segmentIndex: 1, startDistance: 1000 });
    expect(partial.parts[0].endDistance).toBeCloseTo(1200, 6);
  });

  it('uses activity-aware jump rejection and recovers after an invalid fix', () => {
    const fastJump = [{ id: 'jump', points: [at(0, 0), at(1000, 10_000)] }];
    expect(computeDistanceSplits(fastJump, 1000, { activity: 'hike' })).toEqual([]);
    const travel = computeDistanceSplits(fastJump, 1000, { activity: 'travel' });
    expect(travel).toHaveLength(1);
    expect(travel[0].distance).toBe(1000);
    expect(travel[0].maxSpeed).toBeCloseTo(100, 6);

    const recovered = computeDistanceSplits([{
      id: 'recovery',
      points: [at(0, 0), at(5000, 10_000), at(5100, 70_000)]
    }], 1000, { activity: 'hike' });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      duration: 70_000,
      activeMs: 60_000,
      movingMs: 60_000,
      pointCount: 3,
      partial: true
    });
    expect(recovered[0].distance).toBeCloseTo(100, 6);
    expect(recovered[0].avgSpeed).toBeCloseTo(100 / 60, 6);
    expect(recovered[0].maxSpeed).toBeCloseTo(100 / 60, 6);
    expect(recovered[0].parts).toHaveLength(2);
    expect(recovered[0].parts[0].points).toHaveLength(1);
    expect(recovered[0].parts[1].startDistance).toBe(0);
  });

  it('drops duplicate timestamps before measuring split distance', () => {
    const [split] = computeDistanceSplits([{
      id: 'duplicate-time',
      points: [at(0, 0), at(100, 60_000), at(200, 60_000), at(300, 120_000)]
    }], 1000);

    expect(split).toMatchObject({
      distance: 300,
      duration: 120_000,
      activeMs: 120_000,
      movingMs: 120_000,
      pointCount: 3,
      partial: true
    });
    expect(split.parts[0].points.map((point) => point.t)).toEqual([0, 60_000, 120_000]);
  });

  it('skips nonfinite/out-of-range coordinates and backwards timestamps', () => {
    const splits = computeDistanceSplits([{
      id: 'bad-fixes',
      points: [
        at(0, 0),
        { lat: NaN, lon: 0, t: 5_000, alt: 999 },
        { lat: 0, lon: Infinity, t: 10_000, alt: 999 },
        at(100, 60_000),
        at(50, 50_000),
        at(200, 120_000),
        { lat: 91, lon: 0, t: 150_000 },
        { lat: 0, lon: 181, t: 180_000 }
      ]
    }], 1000);

    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({
      distance: 200,
      duration: 120_000,
      activeMs: 120_000,
      movingMs: 120_000,
      pointCount: 3,
      partial: true
    });
    expect(splits[0].avgSpeed).toBeCloseTo(200 / 120, 6);
    expect(splits[0].maxSpeed).toBeCloseTo(200 / 120, 6);
    expect(splits[0].parts[0].points.map((point) => point.t)).toEqual([0, 60_000, 120_000]);
  });

  it('keeps only a meaningful final partial split', () => {
    expect(computeDistanceSplits([{ id: 'tiny', points: [at(0, 0), at(1e-7, 1000)] }], 1000)).toEqual([]);

    const splits = computeDistanceSplits([{
      id: 'nearly-exact',
      points: [at(0, 0), at(1000, 1_000_000), at(1000.0000001, 1_001_000)]
    }], 1000);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ distance: 1000, partial: false, endDistance: 1000 });
  });

  it('counts pauses in duration but not moving time, and caps active step time', () => {
    const splits = computeDistanceSplits([{
      id: 'pace',
      points: [
        at(0, 0),
        at(60, 60_000),
        at(60, 120_000),
        at(180, 180_000),
        at(1180, 780_000)
      ]
    }], 1000);

    expect(splits).toHaveLength(2);
    expect(splits[0]).toMatchObject({
      distance: 1000,
      activeMs: 180_000,
      movingMs: 120_000,
      maxSpeed: 2,
      pointCount: 5
    });
    expect(splits[0].duration).toBeCloseTo(672_000, 6);
    expect(splits[0].avgSpeed).toBeCloseTo(1000 / 120, 6);
    expect(splits[1]).toMatchObject({
      activeMs: 0,
      movingMs: 0,
      avgSpeed: 0,
      partial: true
    });
    expect(splits[1].distance).toBeCloseTo(180, 6);
    expect(splits[1].duration).toBeCloseTo(108_000, 6);
    expect(splits[1].maxSpeed).toBeCloseTo(1000 / 600, 6);
  });

  it('uses a strict greater-than 0.5 m/s moving threshold', () => {
    const [split] = computeDistanceSplits([{
      id: 'slow',
      points: [at(0, 0), at(30, 60_000), at(54, 120_000)]
    }], 1000);
    expect(split.activeMs).toBe(120_000);
    expect(split.movingMs).toBe(0);
    expect(split.avgSpeed).toBe(0);
    expect(split.maxSpeed).toBeCloseTo(0.5, 6);
  });

  it('handles empty, stationary, untimed, and constant-time tracks', () => {
    expect(computeDistanceSplits([])).toEqual([]);
    expect(computeDistanceSplits([{ id: 'empty', points: [] }, { id: 'one', points: [at(0)] }])).toEqual([]);
    expect(computeDistanceSplits([{
      id: 'stationary',
      points: [at(0, 0), at(0, 60_000), at(0, 120_000)]
    }])).toEqual([]);

    const [untimed] = computeDistanceSplits([{
      id: 'untimed',
      points: [{ lat: 0, lon: 0 }, { lat: 0, lon: at(100).lon }]
    }]);
    expect(untimed).toMatchObject({ distance: 100, duration: 0, activeMs: 0, movingMs: 0, avgSpeed: 0, maxSpeed: 0 });

    expect(computeDistanceSplits([{
      id: 'constant-time',
      points: [at(0, 500), at(100, 500), at(200, 500)]
    }])).toEqual([]);
  });

  it('does not mutate segments, points, or options', () => {
    const segments = deepFreeze([
      { id: 'a', points: [at(0, 0, 10), at(600, 300_000, 20)] },
      { id: 'b', points: [at(5000, 600_000, 30), at(5700, 900_000, 40)] }
    ]);
    const opts = deepFreeze({ activity: 'hike', ascentThreshold: 4 });
    const before = JSON.stringify(segments);

    const splits = computeDistanceSplits(segments, 1000, opts);

    expect(JSON.stringify(segments)).toBe(before);
    expect(splits).toHaveLength(2);
    expect(splits[0].parts[0].points[0]).not.toBe(segments[0].points[0]);
    expect(splits[0].parts[1].points[0]).not.toBe(segments[1].points[0]);
  });
});

describe('distance split worker plumbing', () => {
  it('falls back to the pure implementation when workers are unavailable', async () => {
    class UnavailableWorker {
      constructor() { throw new Error('workers unavailable'); }
    }
    vi.stubGlobal('Worker', UnavailableWorker);
    const segments = [{ id: 'async', points: [at(0, 0), at(1500, 750_000)] }];

    await expect(computeDistanceSplitsAsync(segments, 1000, { activity: 'hike' }))
      .resolves.toEqual(computeDistanceSplits(segments, 1000, { activity: 'hike' }));
  });

  it('handles the splits task in the compute worker', async () => {
    const scope: any = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/worker/compute.worker');
    const segments = [{ id: 'worker', points: [at(0, 0), at(1500, 750_000)] }];
    const payload = { segments, intervalM: 1000, opts: { activity: 'hike' } };

    scope.onmessage({ data: { id: 7, type: 'splits', payload } });

    expect(scope.postMessage).toHaveBeenCalledTimes(1);
    const message = scope.postMessage.mock.calls[0][0];
    expect(message).toMatchObject({ id: 7, ok: true });
    expect(message.result).toEqual(computeDistanceSplits(segments, 1000, payload.opts));
  });
});
