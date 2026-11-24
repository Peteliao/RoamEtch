import { describe, expect, it } from 'vitest';
import { assessGpsQuality, cleanTrackSegments } from '../src/core/gpsQuality';

function fix(t, acc = 5, alt = 100) {
  return { lat: 30, lon: 120, t, acc, alt };
}

describe('GPS quality', () => {
  it('scores a clean, continuous track highly', () => {
    const q = assessGpsQuality([fix(0), fix(30_000), fix(60_000), fix(90_000)]);
    expect(q.score).toBeGreaterThanOrEqual(95);
    expect(q.rating).toBe('excellent');
    expect(q.gaps).toBe(0);
    expect(q.avgAcc).toBe(5);
  });

  it('penalises poor accuracy and long gaps', () => {
    const q = assessGpsQuality([
      fix(0, 80, 100), fix(30_000, 90, 110),
      fix(1_200_000, 70, 170), fix(1_230_000, 85, 100)
    ]);
    expect(q.gaps).toBe(1);
    expect(q.gapMs).toBeGreaterThan(1_000_000);
    expect(q.poorFixes).toBe(4);
    expect(q.altJumps).toBe(1);
    expect(q.score).toBeLessThan(50);
    expect(q.rating).toBe('poor');
  });

  it('detects and penalises high-frequency sharp reversals', () => {
    const points = Array.from({ length: 24 }, (_, i) => ({
      lat: 30, lon: 120 + (i % 2) * 0.001, t: i * 5_000, acc: 5, alt: 100
    }));
    const q = assessGpsQuality(points, { activity: 'drive' });
    expect(q.reversals).toBe(22);
    expect(q.score).toBeLessThan(70);
    expect(q.rating).toBe('fair');
  });

  it('removes a false backtracking cluster while keeping the forward track', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
    const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
    const resumed = point(-450, 40_000);
    const result = cleanTrackSegments([{ id: 's1', points: [...forward, ...falseCluster, resumed] }], 'drive');
    expect(result.removed).toBe(3);
    expect(result.segments[0].points).toEqual([...forward, resumed]);
  });

  it('keeps a sustained relocation after four consistent fixes', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const points = [point(0, 0), point(1_000, 10_000), point(1_100, 20_000), point(1_200, 30_000), point(1_300, 40_000)];
    const result = cleanTrackSegments([{ id: 's1', points }], 'drive');
    expect(result.removed).toBe(0);
    expect(result.segments[0].points).toEqual(points);
  });

  it('preserves an unresolved relocation tail instead of deleting uncertain fixes', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const points = [point(0, 0), point(1_000, 10_000), point(1_100, 20_000)];
    const result = cleanTrackSegments([{ id: 's1', points }], 'drive');
    expect(result.removed).toBe(0);
    expect(result.segments[0].points).toEqual(points);
  });

  it('preserves a legitimate three-point relocation segment', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const segments = [
      { id: 's1', points: [point(0, 0)] },
      { id: 's2', points: [point(1_000, 10_000), point(1_100, 20_000), point(1_200, 30_000)] }
    ];
    const result = cleanTrackSegments(segments, 'drive');
    expect(result.removed).toBe(0);
    expect(result.segments).toEqual(segments);
  });

  it('does not treat a long paused gap as a relocation anomaly', () => {
    const result = cleanTrackSegments([
      { id: 's1', points: [{ lat: 30, lon: 120, t: 0 }] },
      { id: 's2', points: [{ lat: 30, lon: 120.05, t: 120_000 }] }
    ], 'drive');
    expect(result.removed).toBe(0);
  });

  it('returns no score when there is neither accuracy nor time', () => {
    const q = assessGpsQuality([{ lat: 30, lon: 120, alt: 100 }, { lat: 30.001, lon: 120, alt: 101 }]);
    expect(q.score).toBe(null);
    expect(q.hasTime).toBe(false);
  });
});
