import { describe, expect, it } from 'vitest';
import { computeStats } from '../src/core/stats';
import { computeDistanceSplits } from '../src/core/distanceSplits';

function track(points) {
  return [{ id: 'seg-1', points }];
}

function movingSegment(startT, endT, baseLat = 30) {
  const points = [];
  for (let t = startT; t <= endT; t += 60_000) {
    const step = (t - startT) / 60_000;
    points.push({ lat: baseLat + step * 0.0008, lon: 120, alt: 100, t });
  }
  return { id: `seg-${startT}`, points };
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

  it('re-derives distance and calories when switching between drive and hike', () => {
    const points = [
      { lat: 30, lon: 120, alt: 100, t: 0 },
      { lat: 30.0008, lon: 120, alt: 100, t: 60_000 },
      { lat: 30.0048, lon: 120, alt: 100, t: 120_000 }
    ];
    const drive = computeStats(track(points), { activity: 'drive', weightKg: 70 });
    const hike = computeStats(track(points), { activity: 'hike', weightKg: 70 });

    expect(drive.calories).toBeNull();
    expect(hike.calories).toBeGreaterThan(0);
    expect(drive.distance).toBeGreaterThan(hike.distance);
    expect(drive.movingMs).toBeGreaterThan(hike.movingMs);
    expect(hike.distance).toBeGreaterThan(0);
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
    expect(untimed.activeMs).toBe(0);
    expect(untimed.movingMs).toBe(0);
    expect(untimed.stillMs).toBe(0);
    expect(untimed.breakMs).toBe(0);

    const empty = computeStats([], {});
    expect(empty.distance).toBe(0);
    expect(empty.pointCount).toBe(0);
    expect(empty.calories).toBeNull();
  });

  it('keeps a pause between segments out of moving and still time', () => {
    const stats = computeStats([
      movingSegment(0, 2 * 3600_000),
      movingSegment(3 * 3600_000, 5 * 3600_000, 30.5)
    ], { activity: 'hike', weightKg: 65 });
    expect(stats.duration).toBe(5 * 3600_000);
    expect(stats.activeMs).toBe(4 * 3600_000);
    expect(stats.movingMs).toBe(4 * 3600_000);
    expect(stats.stillMs).toBe(0);
    expect(stats.breakMs).toBe(3600_000);
    expect(stats.segments[0].activeMs).toBe(2 * 3600_000);
  });

  it('counts a stationary track as still, not as a gap', () => {
    const stats = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30, lon: 120, t: 60_000 },
      { lat: 30, lon: 120, t: 120_000 }
    ]), {});
    expect(stats.duration).toBe(120_000);
    expect(stats.activeMs).toBe(120_000);
    expect(stats.movingMs).toBe(0);
    expect(stats.stillMs).toBe(120_000);
    expect(stats.breakMs).toBe(0);
  });

  it('treats intervals beyond the sample cap as gaps', () => {
    const stats = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30.001, lon: 120, t: 200_000 }
    ]), {});
    expect(stats.duration).toBe(200_000);
    expect(stats.activeMs).toBe(0);
    expect(stats.movingMs).toBe(0);
    expect(stats.stillMs).toBe(0);
    expect(stats.breakMs).toBe(200_000);
  });

  it('accepts exactly 60 s between fixes and rejects longer ones', () => {
    const boundary = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30.001, lon: 120, t: 60_000 }
    ]), {});
    expect(boundary.activeMs).toBe(60_000);

    const over = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30.001, lon: 120, t: 60_001 }
    ]), {});
    expect(over.activeMs).toBe(0);
    expect(over.breakMs).toBe(60_001);
  });

  it('excludes an impossible within-segment edge from distance and speed', () => {
    const stats = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30, lon: 120.01, t: 1_000, speed: 3 }
    ]), { activity: 'hike' });
    expect(stats.distance).toBe(0);
    expect(stats.maxSpeed).toBe(0);
    expect(stats.activeMs).toBe(1_000);
    expect(stats.movingMs).toBe(0);
  });

  it('uses the stricter distance envelope when speed and heading are both missing', () => {
    const points = [
      { lat: 30, lon: 120, t: 0 },
      { lat: 30, lon: 120.000575, t: 10_000 }
    ];
    expect(computeStats(track(points), { activity: 'hike' }).distance).toBe(0);
    expect(computeStats(track([points[0], { ...points[1], speed: 0 }]), { activity: 'hike' }).distance).toBeGreaterThan(50);
  });

  it('allows genuine high-speed travel above the old 80 m/s stats cap', () => {
    const stats = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30, lon: 120.0094, t: 10_000 }
    ]), { activity: 'travel' });
    expect(stats.distance).toBeGreaterThan(850);
    expect(stats.maxSpeed).toBeGreaterThan(80);
    expect(stats.maxSpeed).toBeLessThan(100);
  });

  it('ignores duplicate and backwards timestamps without corrupting duration', () => {
    const stats = computeStats(track([
      { lat: 30, lon: 120, t: 0 },
      { lat: 30.001, lon: 120, t: 60_000 },
      { lat: 30.002, lon: 120, t: 60_000 },
      { lat: 30.003, lon: 120, t: 30_000 }
    ]), {});
    expect(stats.duration).toBe(60_000);
    expect(stats.activeMs).toBe(60_000);
    expect(stats.movingMs).toBe(60_000);
    expect(stats.stillMs).toBe(0);
    expect(stats.breakMs).toBe(0);
    expect(stats.pointCount).toBe(2);
    expect(stats.distance).toBeCloseTo(111.195, 3);
    expect(stats.series.d).toHaveLength(2);
  });

  it('keeps chart distance and split distance aligned for malformed or backwards fixes', () => {
    const lon = (distance: number) => (distance / 6371008.8) * 180 / Math.PI;
    const points = [
      { lat: 0, lon: 0, t: 0 },
      { lat: NaN, lon: 0, t: 30_000 },
      { lat: 0, lon: lon(100), t: 60_000 },
      { lat: 0, lon: lon(50), t: 30_000 },
      { lat: 0, lon: lon(200), t: 120_000 }
    ];
    const stats = computeStats(track(points), { activity: 'hike' });
    const splits = computeDistanceSplits(track(points), 1000, { activity: 'hike' });

    expect(stats.pointCount).toBe(3);
    expect(stats.series.d).toHaveLength(3);
    expect(stats.series.d[0]).toBe(0);
    expect(stats.series.d.at(-1)).toBeCloseTo(200, 3);
    expect(splits.reduce((sum, split) => sum + split.distance, 0)).toBeCloseTo(stats.distance, 6);
  });

  it('computes an identical summary without allocating chart series', () => {
    const points = [
      { lat: 30, lon: 120, alt: 100, t: 0 },
      { lat: 30.001, lon: 120, alt: 110, t: 60_000 },
      { lat: 30.001, lon: 120, alt: null, t: 120_000 },
      { lat: 30.002, lon: 120, alt: 108, t: 180_000 }
    ];
    const full = computeStats(track(points), { activity: 'hike', weightKg: 65 });
    const { series, ...expectedSummary } = full;

    const summary = computeStats(track(points), { activity: 'hike', weightKg: 65, series: false });

    expect(series).toBeDefined();
    expect(summary).toEqual(expectedSummary);
    expect(summary.series).toBeUndefined();
  });

  it('summarizes a 100k-point track without building per-point series', () => {
    const points = Array.from({ length: 100_000 }, (_, index) => ({
      lat: 30 + index * 0.000001,
      lon: 120,
      alt: 100 + Math.sin(index / 100) * 5,
      t: index * 1000
    }));

    const summary = computeStats(track(points), { activity: 'hike', series: false });

    expect(summary.pointCount).toBe(100_000);
    expect(summary.duration).toBe(99_999_000);
    expect(summary.distance).toBeGreaterThan(10_000);
    expect(summary.series).toBeUndefined();
  });
});
