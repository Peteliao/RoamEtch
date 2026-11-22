import { describe, expect, it } from 'vitest';
import {
  ascentDescent,
  bearing,
  emaSeries,
  fmtDistance,
  fmtDuration,
  fmtSpeed,
  haversine,
  simplify
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
