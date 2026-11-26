import { describe, expect, it } from 'vitest';
import {
  assessGpsQuality, assessTrackGpsQuality, buildTrackCleanupEdits, cleanTrackSegments,
  previewTrackCleanup, sameTrackCleanupPreview
} from '../src/core/gpsQuality';

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

  it('assesses segments without flattening a second point array', () => {
    const segments = [
      { points: [fix(0), fix(30_000)] },
      { points: [fix(60_000), fix(90_000)] }
    ];
    expect(assessTrackGpsQuality(segments)).toEqual(
      assessGpsQuality(segments.flatMap((segment) => segment.points))
    );
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

  it('reports duplicate fixes and invalid timestamp order', () => {
    const point = { lat: 30, lon: 120, t: 10_000, acc: 5, alt: 100 };
    const q = assessGpsQuality([point, { ...point }, { ...point, t: 5_000 }]);
    expect(q.duplicateFixes).toBe(1);
    expect(q.invalidTimes).toBe(2);
    expect(q.score).toBeLessThan(95);
  });

  it('returns reasons and displacement for each rejected anomaly cluster', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
    const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
    const result = cleanTrackSegments([{ id: 's1', points: [...forward, ...falseCluster, point(-450, 40_000)] }], 'drive');
    expect(result.removedPoints).toHaveLength(3);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ segmentId: 's1', count: 3, reason: 'speed' });
    expect(result.issues[0].distance).toBeGreaterThan(300);
    expect(result.impactDistance).toBeCloseTo(result.issues[0].distance);
  });

  it('builds a lightweight preview without retaining a second full track', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
    const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
    const segments = [{ id: 's1', points: [...forward, ...falseCluster, point(-450, 40_000)] }];

    const preview = previewTrackCleanup(segments, 'drive');
    const edits = buildTrackCleanupEdits(segments, preview);

    expect(preview).toMatchObject({ version: 1, activity: 'drive', removed: 3 });
    expect(preview).not.toHaveProperty('segments');
    expect(preview).not.toHaveProperty('removedPoints');
    expect(preview.removals.map((removal) => removal.index)).toEqual([5, 6, 7]);
    expect(edits).toEqual([{ segmentId: 's1', before: segments[0].points, after: [...forward, segments[0].points[8]] }]);
  });

  it('compares preview point identity consistently including NaN metadata', () => {
    const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
    const points = [0, -100, -200, -300, -400].map((lon, i) => ({ ...point(lon, i * 5_000), alt: NaN }));
    const first = previewTrackCleanup([{ id: 's1', points }], 'drive');
    const second = previewTrackCleanup([{ id: 's1', points: points.map((p) => ({ ...p })) }], 'drive');

    expect(sameTrackCleanupPreview(first, second)).toBe(true);
    expect(sameTrackCleanupPreview({ ...first, removals: null }, second)).toBe(false);
    expect(sameTrackCleanupPreview({ ...first, issues: {} }, second)).toBe(false);
  });

  it('rejects malformed or inconsistent cleanup edit plans', () => {
    const segments = [{ id: 's1', points: [
      { lat: 30, lon: 120, t: 0 }, { lat: 30, lon: 120.01, t: 5_000 }
    ] }];
    const preview = previewTrackCleanup(segments, 'drive');
    const invalid = [
      null,
      { ...preview, removed: 1 },
      { ...preview, removals: [{ segmentId: 's1', segmentIndex: 0, index: 0, reason: 'speed', distance: 0 }] },
      { ...preview, removals: [{ segmentId: 'other', segmentIndex: 0, index: 1, reason: 'speed', distance: 0 }] },
      { ...preview, removals: [
        { segmentId: 's1', segmentIndex: 0, index: 1, reason: 'speed', distance: 0 },
        { segmentId: 's1', segmentIndex: 0, index: 1, reason: 'speed', distance: 0 }
      ] }
    ];
    for (const plan of invalid) expect(() => buildTrackCleanupEdits(segments, plan)).toThrow('invalid-preview');
  });
});
