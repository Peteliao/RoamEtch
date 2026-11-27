import { describe, expect, it } from 'vitest';
import {
  ascentDescent,
  bearing,
  emaSeries,
  fmtDistance,
  fmtDuration,
  fmtSpeed,
  haversine,
  mergeWgs84Bounds,
  sampleTrackSegments,
  simplify,
  trackDistance,
  usableTrackPoints,
  wgs84TrackBounds
} from '../src/core/geo';

describe('geodesy', () => {
  it('measures the Beijing–Shanghai great-circle distance', () => {
    const metres = haversine(39.9042, 116.4074, 31.2304, 121.4737);
    expect(metres).toBeGreaterThan(1_060_000);
    expect(metres).toBeLessThan(1_075_000);
  });

  it('returns cardinal bearings', () => {
    expect(bearing(0, 0, 0, 1)).toBeCloseTo(90, 3);
    expect(bearing(0, 0, 1, 0)).toBeCloseTo(0, 3);
    expect(bearing(0, 0, 0, -1)).toBeCloseTo(270, 3);
  });

  it('drops invalid, backwards, and duplicate-time fixes before measuring distance', () => {
    const points = [
      { lat: 0, lon: 0, t: 0 },
      { lat: NaN, lon: 0, t: 1000 },
      { lat: 0, lon: 0.001, t: 60_000 },
      { lat: 0, lon: 0.002, t: 60_000 },
      { lat: 0, lon: 0.001, t: 30_000 },
      { lat: 0, lon: 0.003, t: 120_000 }
    ];

    expect(usableTrackPoints(points).map((point) => point.t)).toEqual([0, 60_000, 120_000]);
    expect(trackDistance([{ points }])).toBeCloseTo(333.585, 3);
  });
});

describe('WGS-84 bounds', () => {
  it('merges nearby tracks across the antimeridian without spanning the globe', () => {
    const bounds = mergeWgs84Bounds([
      [179.99, 0, -179.99, 1],
      [-179.98, -1, -179.97, 0]
    ]);
    expect(bounds?.[0]).toBeCloseTo(179.99, 8);
    expect(bounds?.[1]).toBe(-1);
    expect(bounds?.[2]).toBeCloseTo(-179.97, 8);
    expect(bounds?.[3]).toBe(1);
  });

  it('keeps ordinary, point, and whole-world bounds intact', () => {
    expect(mergeWgs84Bounds([[120, 30, 121, 31], [119, 29, 122, 32]])).toEqual([119, 29, 122, 32]);
    expect(mergeWgs84Bounds([[120, 30, 120, 30]])).toEqual([120, 30, 120, 30]);
    expect(mergeWgs84Bounds([[-180, -90, 180, 90]])).toEqual([-180, -90, 180, 90]);
    expect(mergeWgs84Bounds([null, undefined])).toBeNull();
  });

  it('unwraps edges per segment and merges disconnected dateline segments', () => {
    const bounds = wgs84TrackBounds([
      { points: [{ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 }] },
      { points: [{ lat: 1, lon: -179.98 }, { lat: 1, lon: -179.97 }] }
    ]);
    expect(bounds?.[0]).toBeCloseTo(179.99, 8);
    expect(bounds?.[1]).toBe(0);
    expect(bounds?.[2]).toBeCloseTo(-179.97, 8);
    expect(bounds?.[3]).toBe(1);
    expect(wgs84TrackBounds([
      { points: [{ lat: 0, lon: 120 }, { lat: 0, lon: 121 }] },
      { points: [{ lat: 1, lon: 122 }, { lat: 1, lon: 123 }] }
    ])).toEqual([120, 0, 123, 1]);
  });

  it('ignores invalid coordinates at the track boundary', () => {
    expect(wgs84TrackBounds([{ points: [
      { lat: NaN, lon: 0 }, { lat: 0, lon: 181 }, { lat: 30, lon: 120 }
    ] }])).toEqual([120, 30, 120, 30]);
  });
});

describe('track simplification', () => {
  it('keeps endpoints and removes collinear points', () => {
    const points = Array.from({ length: 101 }, (_, i) => ({ lat: 30, lon: 120 + i * 0.00001 }));
    const simplified = simplify(points, 5);
    expect(simplified.length).toBe(2);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[1]).toEqual(points[points.length - 1]);
  });

  it('keeps meaningful turns', () => {
    const points = [
      { lat: 30, lon: 120 },
      { lat: 30, lon: 120.001 },
      { lat: 30.002, lon: 120.001 },
      { lat: 30.002, lon: 120.002 }
    ];
    expect(simplify(points, 10).length).toBe(4);
  });
});

describe('track preview sampling', () => {
  it('bounds work while preserving every segment endpoint', () => {
    const segments = [
      { id: 'a', points: Array.from({ length: 10_000 }, (_, index) => ({ lat: index, lon: 0 })) },
      { id: 'b', points: Array.from({ length: 10_000 }, (_, index) => ({ lat: index, lon: 1 })) }
    ];
    const sampled = sampleTrackSegments(segments, 4000);
    expect(sampled.reduce((sum, segment) => sum + segment.points.length, 0)).toBe(4000);
    expect(sampled.map((segment) => segment.id)).toEqual(['a', 'b']);
    expect(sampled[0].points[0]).toBe(segments[0].points[0]);
    expect(sampled[0].points.at(-1)).toBe(segments[0].points.at(-1));
    expect(sampled[1].points[0]).toBe(segments[1].points[0]);
    expect(sampled[1].points.at(-1)).toBe(segments[1].points.at(-1));
  });

  it('keeps small tracks unchanged and handles tiny budgets', () => {
    const segments = [{ id: 'small', points: [{ lat: 0, lon: 0 }, { lat: 1, lon: 1 }] }];
    expect(sampleTrackSegments(segments, 4000)).toEqual(segments);
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: String(index), points: Array.from({ length: 100 }, (__, point) => ({ lat: point, lon: index }))
    }));
    expect(sampleTrackSegments(many, 2).flatMap((segment) => segment.points)).toHaveLength(2);
  });
});

describe('elevation helpers', () => {
  it('smooths numeric series and preserves null gaps', () => {
    expect(emaSeries([10, null, 20], 0.3)).toEqual([10, null, 13]);
  });

  it('counts ascent and descent only past the hysteresis threshold', () => {
    expect(ascentDescent([100, 102, 103, 106, 104, 101, 99], 4)).toEqual({ ascent: 6, descent: 5 });
    expect(ascentDescent([100, 101, 102, 101, 100], 4)).toEqual({ ascent: 0, descent: 0 });
  });
});

describe('formatters', () => {
  it('formats distance in metric and imperial units', () => {
    expect(fmtDistance(1500, 'metric')).toEqual({ v: '1.50', u: 'km' });
    expect(fmtDistance(500, 'metric')).toEqual({ v: '500', u: 'm' });
    expect(fmtDistance(1609.344, 'imperial')).toEqual({ v: '1.00', u: 'mi' });
  });

  it('formats duration and speed', () => {
    expect(fmtDuration(3_661_000)).toBe('1:01:01');
    expect(fmtDuration(90_000, { compact: true })).toBe('1m30s');
    expect(fmtSpeed(10, 'metric')).toEqual({ v: '36.0', u: 'km/h' });
  });
});
