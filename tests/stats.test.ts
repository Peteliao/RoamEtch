import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/core/stats';

function track(points) {
  return [{ id: 'seg-1', points }];
}

describe('trip statistics', () => {
  it('computes distance, duration and smoothed ascent for a timed track', () => {
    const points = [
      { lat: 30, lon: 120, alt: 100, t: 0 },
      { lat: 30.001, lon: 120, alt: 110, t: 60_000 },
      { lat: 30.002, lon: 120, alt: 108, t: 120_000 },
      { lat: 30.003, lon: 120, alt: 120, t: 180_000 }
    ];
    const stats = computeStats(track(points), { activity: 'hike', weightKg: 65, ascentThreshold: 4 });
    expect(stats.distance).toBeGreaterThan(300);
    expect(stats.distance).toBeLessThan(350);
    expect(stats.duration).toBe(180_000);
    expect(stats.movingMs).toBe(180_000);
    expect(stats.hasTime).toBe(true);
    expect(stats.pointCount).toBe(4);
    expect(stats.segCount).toBe(1);
    expect(stats.ascent).toBeGreaterThan(0);
    expect(stats.series.d).toHaveLength(4);
    expect(stats.series.alt[0]).toBe(100);
  });

  it('honours a larger hysteresis threshold', () => {
    const points = [
      { lat: 30, lon: 120, alt: 100, t: 0 },
      { lat: 30.001, lon: 120, alt: 102, t: 60_000 },
      { lat: 30.002, lon: 120, alt: 104, t: 120_000 }
    ];
    const strict = computeStats(track(points), { ascentThreshold: 100 });
    expect(strict.ascent).toBe(0);
  });

  it('handles tracks without timestamps and empty input', () => {
    const untimed = computeStats(track([
      { lat: 30, lon: 120, alt: null, t: null },
      { lat: 30.001, lon: 120, alt: null, t: null }
    ]), {});
    expect(untimed.hasTime).toBe(false);
    expect(untimed.duration).toBe(0);
    expect(untimed.movingMs).toBe(0);

    const empty = computeStats([], {});
    expect(empty.distance).toBe(0);
    expect(empty.pointCount).toBe(0);
    expect(empty.calories).toBeNull();
  });
});
