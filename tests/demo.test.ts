import { describe, expect, it } from 'vitest';
import { buildDemoPoints, buildDemoWaypoints } from '../src/core/demo';
import { haversine } from '../src/core/geo';

const labels = { start: 'start', view: 'view', photo: 'photo', food: 'food', end: 'end' };

describe('built-in demo trip', () => {
  const points = buildDemoPoints(1_800_000_000_000);

  it('builds a closed loop with elevation and timestamps', () => {
    expect(points).toHaveLength(361);
    expect(points[0].t).toBeLessThan(points[points.length - 1].t);
    expect(points.every((p) => p.alt != null && p.alt > 50)).toBe(true);
    expect(points[0].lat).toBeCloseTo(points[points.length - 1].lat, 9);
    expect(points[0].lon).toBeCloseTo(points[points.length - 1].lon, 9);
  });

  it('covers a plausible hike distance', () => {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      total += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    expect(total).toBeGreaterThan(4_000);
    expect(total).toBeLessThan(12_000);
  });

  it('places typed waypoints on the track', () => {
    const waypoints = buildDemoWaypoints(points, labels);
    expect(waypoints.map((w) => w.type)).toEqual(['start', 'view', 'photo', 'food', 'end']);
    expect(waypoints.map((w) => w.name)).toEqual(['start', 'view', 'photo', 'food', 'end']);
    expect(waypoints[0].time).toBe(points[0].t);
    expect(waypoints[waypoints.length - 1].time).toBe(points[points.length - 1].t);
    expect(waypoints[2].alt).toBe(points[180].alt);
  });
});
