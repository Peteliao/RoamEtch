import { describe, expect, it } from 'vitest';
import { assessTrackGpsQuality } from '../src/core/gpsQuality';
import {
  compareTracks,
  DEFAULT_TRACK_COMPARISON_TOLERANCE_M,
  type TrackComparisonInput,
  type TrackComparisonPoint
} from '../src/core/trackComparison';

const M_PER_DEGREE = 6_371_008.8 * Math.PI / 180;

function point(distanceM: number, extra: Partial<TrackComparisonPoint> = {}): TrackComparisonPoint {
  return { lat: 0, lon: distanceM / M_PER_DEGREE, ...extra };
}

function line(fromM: number, toM: number, spacingM = 10, extra: Partial<TrackComparisonPoint> = {}): TrackComparisonPoint[] {
  const points: TrackComparisonPoint[] = [];
  const count = Math.max(1, Math.ceil((toM - fromM) / spacingM));
  for (let index = 0; index <= count; index++) {
    points.push(point(fromM + (toM - fromM) * index / count, extra));
  }
  return points;
}

function track(segments: TrackComparisonInput['segments'], extra: Partial<TrackComparisonInput> = {}): TrackComparisonInput {
  return { segments, ...extra };
}

describe('track comparison', () => {
  it('compares identical routes exactly with an explicit 30 m tolerance', () => {
    const points = line(0, 500, 25, { t: 0, alt: 10 });
    const result = compareTracks(track([{ id: 'a1', points }], { id: 'a', name: 'A' }), track([{ id: 'b1', points }], { id: 'b' }));

    expect(result.direction).toBe('forward');
    expect(result.toleranceM).toBe(DEFAULT_TRACK_COMPARISON_TOLERANCE_M);
    expect(result.toleranceM).toBe(30);
    expect(result.tracks.a).toMatchObject({ id: 'a', name: 'A', pointCount: 21 });
    expect(result.tracks.a.lengthM).toBeCloseTo(500, 6);
    for (const summary of [result.summaries.forward, result.summaries.reverse]) {
      expect(summary.meanErrorM).toBeLessThan(0.001);
      expect(summary.p95ErrorM).toBeLessThan(0.001);
      expect(summary.matchedRatio).toBeCloseTo(1, 12);
      expect(summary.matchedDistanceM).toBeCloseTo(500, 6);
      expect(summary.unmatchedDistanceM).toBeCloseTo(0, 6);
      expect(summary.lengthRatio).toBe(1);
    }
    expect(result.gpsQuality.a.fixes).toBe(21);
    expect(result.errors).toEqual([]);
  });

  it('uses source quality and point counts when alignment geometry was simplified', () => {
    const rawPoints = line(0, 100, 10, { acc: 100 });
    const sourceGpsQuality = assessTrackGpsQuality([{ points: rawPoints }], { activity: 'hike' });
    const simplifiedPoints = line(0, 100, 10, { acc: 5 });
    const input = track([{ points: simplifiedPoints }], {
      sourcePointCount: rawPoints.length,
      sourceGpsQuality
    });

    const result = compareTracks(input, track([{ points: simplifiedPoints }]));

    expect(result.tracks.a.pointCount).toBe(rawPoints.length);
    expect(result.gpsQuality.a).toEqual(sourceGpsQuality);
    expect(result.gpsQuality.a.fixes).toBe(rawPoints.length);
  });

  it('matches a route recorded in reverse, including reversed segment order', () => {
    const first = line(0, 300, 30);
    const second = line(500, 800, 30);
    const a = track([{ id: 'one', points: first }, { id: 'two', points: second }]);
    const b = track([{ id: 'two', points: [...second].reverse() }, { id: 'one', points: [...first].reverse() }]);
    const result = compareTracks(a, b);

    expect(result.summaries.forward.meanErrorM).toBeLessThan(0.001);
    expect(result.summaries.reverse.meanErrorM).toBeLessThan(0.001);
    expect(result.summaries.forward.matchedRatio).toBeCloseTo(1, 12);
    expect(result.summaries.reverse.matchedRatio).toBeCloseTo(1, 12);
    expect(result.tracks.a.lengthM).toBeCloseTo(600, 6);
    expect(result.tracks.b.lengthM).toBeCloseTo(600, 6);
  });

  it('projects parallel routes and applies the tolerance to matched distance', () => {
    const original = line(0, 400, 20);
    const inside = original.map((fix) => ({ ...fix, lat: 20 / M_PER_DEGREE }));
    const outside = original.map((fix) => ({ ...fix, lat: 45 / M_PER_DEGREE }));
    const near = compareTracks(track([{ points: original }]), track([{ points: inside }]));
    const far = compareTracks(track([{ points: original }]), track([{ points: outside }]));

    expect(near.summaries.forward.meanErrorM).toBeCloseTo(20, 3);
    expect(near.summaries.forward.p95ErrorM).toBeCloseTo(20, 3);
    expect(near.summaries.forward.matchedRatio).toBe(1);
    expect(far.summaries.forward.meanErrorM).toBeCloseTo(45, 3);
    expect(far.summaries.forward.matchedRatio).toBe(0);
    expect(far.summaries.forward.unmatchedDistanceM).toBeCloseTo(400, 3);
  });

  it('reports partial overlap from both source directions', () => {
    const result = compareTracks(
      track([{ points: line(0, 1_000, 10) }]),
      track([{ points: line(200, 700, 10) }])
    );

    expect(result.summaries.forward.matchedDistanceM).toBeCloseTo(570, 3);
    expect(result.summaries.forward.unmatchedDistanceM).toBeCloseTo(430, 3);
    expect(result.summaries.forward.matchedRatio).toBeCloseTo(0.57, 6);
    expect(result.summaries.forward.lengthRatio).toBeCloseTo(0.5, 6);
    expect(result.summaries.reverse.matchedDistanceM).toBeCloseTo(500, 3);
    expect(result.summaries.reverse.unmatchedDistanceM).toBeCloseTo(0, 3);
    expect(result.summaries.reverse.matchedRatio).toBeCloseTo(1, 12);
    expect(result.summaries.reverse.lengthRatio).toBeCloseTo(0.5, 6);
    expect(result.direction).toBe('reverse');
  });

  it('chooses reverse when it has the lower mean error', () => {
    const result = compareTracks(
      track([{ points: line(0, 1_000, 10) }]),
      track([{ points: line(0, 100, 10) }])
    );

    expect(result.summaries.forward.meanErrorM).toBeGreaterThan(300);
    expect(result.summaries.reverse.meanErrorM).toBeLessThan(0.001);
    expect(result.direction).toBe('reverse');
    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.b.lon <= 100 / M_PER_DEGREE + 1e-12)).toBe(true);
  });

  it('never projects across a recording gap between segments', () => {
    const result = compareTracks(
      track([{ points: line(0, 1_100, 10) }]),
      track([
        { id: 'before', points: line(0, 100, 10) },
        { id: 'after', points: line(1_000, 1_100, 10) }
      ])
    );

    expect(result.summaries.forward.matchedDistanceM).toBeCloseTo(270, 3);
    expect(result.summaries.forward.unmatchedDistanceM).toBeCloseTo(830, 3);
    expect(result.summaries.forward.matchedRatio).toBeCloseTo(270 / 1_100, 6);
    expect(result.summaries.forward.p95ErrorM).toBeGreaterThan(400);
    expect(result.summaries.forward.meanErrorM).toBeGreaterThan(150);
    expect(result.summaries.reverse.matchedRatio).toBe(1);
    expect(result.direction).toBe('reverse');
  });

  it('handles absent altitude and time without inventing sample metadata', () => {
    const points = line(0, 100, 25);
    const result = compareTracks(track([{ points }]), track([{ points }]), { sampleSpacingM: 25 });

    expect(result.samples.length).toBe(5);
    for (const sample of result.samples) {
      expect(sample.a).not.toHaveProperty('alt');
      expect(sample.a).not.toHaveProperty('t');
      expect(sample.b).not.toHaveProperty('alt');
      expect(sample.b).not.toHaveProperty('t');
    }
    expect(result.gpsQuality.a.score).toBeNull();
    expect(result.gpsQuality.a.hasTime).toBe(false);
  });

  it('interpolates altitude and time only when both edge endpoints provide them', () => {
    const points = [point(0, { alt: 0, t: 0 }), point(100, { alt: 100, t: 1_000 })];
    const result = compareTracks(
      track([{ points }]),
      track([{ points }]),
      { sampleSpacingM: 25, maxSamples: 10 }
    );

    expect(result.samples).toHaveLength(5);
    expect(result.samples[2]).toMatchObject({
      errorM: expect.any(Number),
      a: { lat: 0, alt: 50, t: 500 },
      b: { lat: 0, alt: 50, t: 500 }
    });
    expect(result.samples[2].distanceM).toBeCloseTo(50, 6);
    expect(result.samples[2].errorM).toBeLessThan(0.001);
  });

  it('honours the sample cap while increasing effective spacing', () => {
    const points = line(0, 5_000, 5);
    const result = compareTracks(track([{ points }]), track([{ points }]), {
      sampleSpacingM: 1,
      maxSamples: 12
    });

    expect(result.samples).toHaveLength(12);
    expect(result.sampling.aSampleCount).toBe(12);
    expect(result.sampling.bSampleCount).toBe(12);
    expect(result.sampling.aEffectiveSpacingM).toBeGreaterThan(400);
    expect(result.summaries.forward.sampleCount).toBe(12);
    expect(result.summaries.forward.matchedRatio).toBeCloseTo(1, 12);
  });

  it('returns explained empty and stationary results', () => {
    const empty = compareTracks(track([]), track([]));
    expect(empty.direction).toBeNull();
    expect(empty.samples).toEqual([]);
    for (const summary of [empty.summaries.forward, empty.summaries.reverse]) {
      expect(summary).toMatchObject({
        meanErrorM: null,
        p95ErrorM: null,
        matchedRatio: 0,
        matchedDistanceM: 0,
        unmatchedDistanceM: 0,
        lengthRatio: 0
      });
    }
    expect(empty.errors.map((error) => error.side)).toEqual(['a', 'b']);

    const stillA = track([{ points: [point(0, { t: 0 }), point(0, { t: 1_000 })] }]);
    const stillB = track([{ points: [point(0)] }]);
    const same = compareTracks(stillA, stillB);
    expect(same.direction).toBeNull();
    expect(same.samples).toEqual([]);
    expect(same.summaries.forward.matchedRatio).toBe(1);
    expect(same.summaries.forward.meanErrorM).toBe(0);
    expect(same.summaries.forward.p95ErrorM).toBe(0);
    expect(same.limitations.some((notice) => notice.code === 'stationary-track')).toBe(true);

    const apart = compareTracks(stillA, track([{ points: [point(40)] }]));
    expect(apart.direction).toBeNull();
    expect(apart.summaries.forward.matchedRatio).toBe(0);
    expect(apart.summaries.forward.meanErrorM).toBeCloseTo(40, 3);
  });

  it('leaves metrics unavailable and selects no direction when either track is empty', () => {
    const route = track([{ points: line(0, 100, 25) }], { id: 'route' });
    const empty = track([], { id: 'empty' });

    for (const result of [compareTracks(route, empty), compareTracks(empty, route)]) {
      expect(result.direction).toBeNull();
      expect(result.samples).toEqual([]);
      for (const summary of [result.summaries.forward, result.summaries.reverse]) {
        expect(summary.meanErrorM).toBeNull();
        expect(summary.p95ErrorM).toBeNull();
        expect(summary.matchedRatio).toBe(0);
        expect(summary.matchedDistanceM).toBe(0);
      }
    }

    const emptyTarget = compareTracks(route, empty);
    expect(emptyTarget.errors).toEqual([expect.objectContaining({ side: 'b', code: 'empty-track' })]);
    expect(emptyTarget.summaries.forward.unmatchedDistanceM).toBeCloseTo(100, 6);
    expect(emptyTarget.summaries.forward.sourceLengthM).toBeCloseTo(100, 6);
    expect(emptyTarget.summaries.forward.targetLengthM).toBe(0);

    const emptySource = compareTracks(empty, route);
    expect(emptySource.errors).toEqual([expect.objectContaining({ side: 'a', code: 'empty-track' })]);
    expect(emptySource.summaries.forward.sourceLengthM).toBe(0);
    expect(emptySource.summaries.forward.targetLengthM).toBeCloseTo(100, 6);
    expect(emptySource.summaries.reverse.unmatchedDistanceM).toBeCloseTo(100, 6);
  });

  it('retains both endpoints of a short track', () => {
    const points = [point(0), point(5)];
    const result = compareTracks(track([{ points }]), track([{ points }]), { sampleSpacingM: 10 });

    expect(result.tracks.a.lengthM).toBeCloseTo(5, 6);
    expect(result.sampling.aSampleCount).toBe(2);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].distanceM).toBe(0);
    expect(result.samples[1].distanceM).toBeCloseTo(5, 6);
    expect(result.limitations.some((notice) => notice.code === 'short-track')).toBe(true);
  });

  it('skips invalid coordinates and explains them without mutating inputs', () => {
    const points = [point(0), { lat: NaN, lon: 0 }, point(100)];
    const input = track([{ points }]);
    const snapshot = [...points];
    const result = compareTracks(input, track([{ points: [point(0), point(100)] }]));

    expect(input.segments[0].points).toEqual(snapshot);
    expect(result.tracks.a.invalidPointCount).toBe(1);
    expect(result.errors).toContainEqual(expect.objectContaining({ side: 'a', code: 'invalid-points', count: 1 }));
    expect(result.tracks.a.lengthM).toBeCloseTo(100, 6);
  });

  it('bounds resampling and returned samples for dense long tracks', () => {
    const points = Array.from({ length: 10_001 }, (_, index) => point(index * 5, { t: index * 1_000, acc: 5 }));
    const result = compareTracks(track([{ points }]), track([{ points }]), {
      sampleSpacingM: 1,
      maxSamples: 256
    });

    expect(result.sampling.aSampleCount).toBe(256);
    expect(result.sampling.bSampleCount).toBe(256);
    expect(result.samples).toHaveLength(200);
    expect(result.summaries.forward.meanErrorM).toBeLessThan(0.001);
    expect(result.summaries.forward.matchedRatio).toBeCloseTo(1, 12);
  });

  it('aborts before and during comparison with an AbortError', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => compareTracks(track([]), track([]), { signal: controller.signal })).toThrow(
      expect.objectContaining({ name: 'AbortError' })
    );

    const during = new AbortController();
    const fix: TrackComparisonPoint = {
      get lat() {
        during.abort();
        return 0;
      },
      lon: 0
    };
    expect(() => compareTracks(
      track([{ points: [fix] }]),
      track([{ points: [point(0)] }]),
      { signal: during.signal }
    )).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });
});
