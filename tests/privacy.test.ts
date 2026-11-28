import { describe, expect, it } from 'vitest';
import { applyPrivacy, countPrivacyCrops } from '../src/core/privacy';
import { haversine } from '../src/core/geo';

function buildTrip() {
  const points = [
    { lat: 30, lon: 120 },
    { lat: 30.001, lon: 120 },
    { lat: 30.002, lon: 120 },
    { lat: 30.003, lon: 120 },
    { lat: 30.004, lon: 120 },
    { lat: 30.005, lon: 120 }
  ];
  return {
    trip: { id: 't1' },
    segments: [{ id: 's1', points }],
    waypoints: [
      { id: 'w1', lat: 30, lon: 120, name: 'start', hidden: false },
      { id: 'w2', lat: 30.002, lon: 120, name: 'mid', hidden: false },
      { id: 'w3', lat: 30.003, lon: 120, name: 'secret', hidden: true },
      { id: 'w4', lat: 30.005, lon: 120, name: 'end', hidden: false }
    ]
  };
}

describe('privacy cropping', () => {
  it('trims points inside start/end circles and hides sensitive nodes', () => {
    const result = applyPrivacy(buildTrip(), { radius: 150, hideSensitive: true });
    expect(result.croppedPoints).toBeGreaterThan(0);
    expect(result.croppedWaypoints).toBe(3);
    expect(result.waypoints.map((w) => w.name)).toEqual(['mid']);
    for (const seg of result.segments) {
      expect(seg.points.length).toBeGreaterThanOrEqual(2);
      expect(seg.id).toMatch(/^s1-p\d+$/);
    }
  });

  it('clips edges that cross a privacy circle between two retained fixes', () => {
    const center = { lat: 30, lon: 120 };
    const crossing = applyPrivacy({
      trip: {}, waypoints: [],
      segments: [{ id: 'crossing', points: [
        { lat: 30, lon: 119.99 }, { lat: 30, lon: 120.01 }
      ] }]
    }, { radius: 300, start: center, end: center });
    expect(crossing.segments).toHaveLength(2);
    for (const segment of crossing.segments) {
      for (const point of segment.points) {
        expect(haversine(point.lat, point.lon, center.lat, center.lon)).toBeGreaterThanOrEqual(300);
      }
    }

    const clipped = applyPrivacy({
      trip: {}, waypoints: [],
      segments: [{ id: 'clipped', points: [
        { lat: 30, lon: 120 }, { lat: 30, lon: 120.01 }
      ] }]
    }, { radius: 300, start: center, end: { lat: 30, lon: 120.02 } });
    expect(clipped.croppedPoints).toBe(1);
    expect(clipped.segments).toHaveLength(1);
    expect(clipped.segments[0].points[0].lon).toBeGreaterThan(120.003);
    expect(clipped.segments[0].points[0].lon).toBeLessThan(120.0033);
  });

  it('clips long high-latitude edges that an equirectangular projection misses', () => {
    const center = { lat: 80.19197782553502, lon: 97.9611555144727 };
    const result = applyPrivacy({
      trip: {}, waypoints: [],
      segments: [{ id: 'polar', points: [
        { lat: 77.17374670184509, lon: 69.90796461709843 },
        { lat: 81.32148365170319, lon: 98.85706157293203 }
      ] }]
    }, { radius: 85_114.1537180286, start: center, end: center });
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of result.segments) {
      expect(segment.points.length).toBeGreaterThanOrEqual(2);
      for (const point of segment.points) {
        expect(haversine(point.lat, point.lon, center.lat, center.lon)).toBeGreaterThanOrEqual(85_114.1537180286 - 0.01);
      }
    }
  });

  it('preserves an explicit end anchor instead of replacing it with the last fix', () => {
    const start = { lat: 0, lon: 0 };
    const end = { lat: 0, lon: 0.01 };
    const result = applyPrivacy({
      trip: {}, waypoints: [],
      segments: [{ id: 'anchors', points: [0, 0.005, 0.01, 0.015, 0.02].map((lon) => ({ lat: 0, lon })) }]
    }, { radius: 300, start, end });
    const retained = result.segments.flatMap((segment) => segment.points);
    expect(retained.length).toBeGreaterThanOrEqual(2);
    expect(retained.every((point) => haversine(point.lat, point.lon, end.lat, end.lon) >= 300 - 0.01)).toBe(true);
    expect(retained.some((point) => point.lon > 0.013)).toBe(true);
  });

  it('keeps every point when the radius is zero', () => {
    const result = applyPrivacy(buildTrip(), { radius: 0, hideSensitive: false });
    expect(result.croppedPoints).toBe(0);
    expect(result.croppedWaypoints).toBe(0);
    expect(result.segments.flatMap((s) => s.points)).toHaveLength(6);
    expect(result.waypoints).toHaveLength(4);
  });

  it('disables all circle cropping at radius zero even with explicit anchors', () => {
    const full = buildTrip();
    const options = { radius: 0, hideSensitive: false, start: full.segments[0].points[0], end: full.segments[0].points.at(-1) };
    const result = applyPrivacy(full, options);
    expect(result.croppedPoints).toBe(0);
    expect(result.croppedWaypoints).toBe(0);
    expect(result.waypoints).toHaveLength(4);
    expect(result.segments.flatMap((segment) => segment.points)).toHaveLength(6);
    expect(countPrivacyCrops(full, options)).toEqual({ croppedPoints: 0, croppedWaypoints: 0 });
  });

  it('reports crop counts without constructing clipped segments', () => {
    const full = buildTrip();
    const result = applyPrivacy(full, { radius: 150, hideSensitive: true });
    expect(countPrivacyCrops(full, { radius: 150, hideSensitive: true })).toEqual({
      croppedPoints: result.croppedPoints,
      croppedWaypoints: result.croppedWaypoints
    });
  });

  it('fails closed when positive-radius anchors are present but invalid', () => {
    const full = buildTrip();
    const options = {
      radius: 300,
      start: { lat: Number.NaN, lon: 120 },
      end: { lat: 30, lon: 181 }
    };
    const result = applyPrivacy(full, options);
    expect(result.segments).toEqual([]);
    expect(result.waypoints).toEqual([]);
    expect(result.croppedPoints).toBe(6);
    expect(result.croppedWaypoints).toBe(4);
    expect(countPrivacyCrops(full, options)).toEqual({
      croppedPoints: result.croppedPoints,
      croppedWaypoints: result.croppedWaypoints
    });

    const partial = applyPrivacy(full, { radius: 300, start: options.start });
    expect(partial.segments).toEqual([]);
    expect(partial.waypoints).toEqual([]);
    expect(countPrivacyCrops(full, { radius: 300, start: options.start })).toEqual({
      croppedPoints: partial.croppedPoints,
      croppedWaypoints: partial.croppedWaypoints
    });
  });

  it('keeps mid-trip passes through the start circle in ends-only mode', () => {
    const start = { lat: 30, lon: 120 };
    const end = { lat: 30.03, lon: 120 };
    const full = {
      trip: { id: 'return-loop' }, waypoints: [],
      segments: [{ id: 'loop', points: [120, 120.005, 120.01, 120.005, 120, 120.005, 120.01]
        .map((lon) => ({ lat: 30, lon })) }]
    };
    const options = { radius: 300, start, end };
    const all = applyPrivacy(full, options);
    const ends = applyPrivacy(full, { ...options, mode: 'ends' });
    expect(all.segments.length).toBeGreaterThan(1);
    expect(ends.segments).toHaveLength(1);
    expect(ends.segments[0].points.some((point) => point.lon === 120)).toBe(true);
    expect(ends.croppedPoints).toBeLessThan(all.croppedPoints);
    expect(countPrivacyCrops(full, { ...options, mode: 'ends' })).toEqual({
      croppedPoints: ends.croppedPoints, croppedWaypoints: 0
    });
  });

  it('offsets circles deterministically without weakening the requested radius', () => {
    const full = {
      trip: { id: 'offset-trip' }, waypoints: [],
      segments: [{ id: 'offset', points: [120, 120.005, 120.01, 120.015, 120.02].map((lon) => ({ lat: 30, lon })) }]
    };
    const options = { radius: 300, offset: true, seed: 'stable-trip' };
    const first = applyPrivacy(full, options);
    const second = applyPrivacy(full, options);
    const plain = applyPrivacy(full, { ...options, offset: false });
    expect(first.segments).toEqual(second.segments);
    expect(first.segments).not.toEqual(plain.segments);
    const anchor = full.segments[0].points[0];
    for (const segment of first.segments) {
      for (const point of segment.points) {
        expect(haversine(point.lat, point.lon, anchor.lat, anchor.lon)).toBeGreaterThanOrEqual(300 - 0.01);
      }
    }
  });

  it('trims ends-only privacy across fully hidden segments', () => {
    const start = { lat: 30, lon: 120 };
    const end = { lat: 30, lon: 120.02 };
    const full = {
      trip: { id: 'segment-ends' }, waypoints: [],
      segments: [
        { id: 'start-hidden', points: [{ lat: 30, lon: 120 }, { lat: 30, lon: 120.001 }] },
        { id: 'start-exit', points: [{ lat: 30, lon: 120.0015 }, { lat: 30, lon: 120.004 }, { lat: 30, lon: 120.006 }] },
        { id: 'middle', points: [{ lat: 30, lon: 120.008 }, { lat: 30, lon: 120.012 }] },
        { id: 'end-enter', points: [{ lat: 30, lon: 120.018 }, { lat: 30, lon: 120.019 }] },
        { id: 'end-hidden', points: [{ lat: 30, lon: 120.019 }, { lat: 30, lon: 120.0195 }] }
      ]
    };
    const result = applyPrivacy(full, { radius: 300, mode: 'ends', start, end });
    const retained = result.segments.flatMap((segment) => segment.points);
    expect(retained.length).toBeGreaterThanOrEqual(4);
    expect(retained.every((point) => haversine(point.lat, point.lon, start.lat, start.lon) >= 300 - 0.01)).toBe(true);
    expect(retained.every((point) => haversine(point.lat, point.lon, end.lat, end.lon) >= 300 - 0.01)).toBe(true);
    expect(retained.some((point) => point.lon > 120.004)).toBe(true);
    expect(retained.some((point) => point.lon < 120.018)).toBe(true);
    expect(countPrivacyCrops(full, { radius: 300, mode: 'ends', start, end })).toEqual({
      croppedPoints: result.croppedPoints,
      croppedWaypoints: 0
    });
  });

  it('splits a diagonal return through an offset privacy circle', () => {
    const center = { lat: 30, lon: 120 };
    const full = {
      trip: { id: 'offset-return' }, waypoints: [],
      segments: [{ id: 'return', points: [
        center,
        { lat: 30.001, lon: 120.003 },
        { lat: 30.004, lon: 120.006 },
        { lat: 30.0005, lon: 120.0005 },
        { lat: 30.006, lon: 120.009 }
      ] }]
    };
    const result = applyPrivacy(full, {
      radius: 150, offset: true, start: center, end: { lat: 31, lon: 121 }
    });
    expect(result.segments.length).toBeGreaterThan(1);
    for (const segment of result.segments) {
      for (const point of segment.points) {
        expect(haversine(point.lat, point.lon, center.lat, center.lon)).toBeGreaterThanOrEqual(150 - 0.01);
      }
    }
  });

  it('handles an empty track', () => {
    const result = applyPrivacy({ trip: {}, segments: [], waypoints: [] }, { radius: 300 });
    expect(result.segments).toEqual([]);
    expect(result.croppedPoints).toBe(0);
  });
});
