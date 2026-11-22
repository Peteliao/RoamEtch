import { describe, expect, it } from 'vitest';
import { applyPrivacy } from '../src/core/privacy';

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

  it('keeps every point when the radius is zero', () => {
    const result = applyPrivacy(buildTrip(), { radius: 0, hideSensitive: false });
    expect(result.croppedPoints).toBe(0);
    expect(result.croppedWaypoints).toBe(0);
    expect(result.segments.flatMap((s) => s.points)).toHaveLength(6);
    expect(result.waypoints).toHaveLength(4);
  });

  it('handles an empty track', () => {
    const result = applyPrivacy({ trip: {}, segments: [], waypoints: [] }, { radius: 300 });
    expect(result.segments).toEqual([]);
    expect(result.croppedPoints).toBe(0);
  });
});
