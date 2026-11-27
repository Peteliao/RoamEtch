import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_CONFIDENCE_THRESHOLD, classifyActivity, classifyActivityDetailed,
  extractActivityFeatures, type ActivitySample
} from '../src/core/activity';

function series(
  speeds: number[],
  options: { intervalMs?: number; elevationChange?: number; distanceScale?: number } = {}
): ActivitySample[] {
  const interval = options.intervalMs ?? 5_000;
  const scale = options.distanceScale ?? 1;
  return speeds.map((speed, index) => ({
    t: index * interval,
    speed,
    dt: index ? interval : 0,
    distance: speed * interval / 1000 * scale,
    elevationChange: index ? options.elevationChange ?? 0 : 0
  }));
}

const HIKING = series(Array(20).fill(1.3), { elevationChange: 0.08 });
const RUNNING = series(Array(20).fill(3.2));
const CYCLING = series(Array(20).fill(7));
const DRIVING = series(Array(20).fill(18));
const TRAVEL = series(Array(20).fill(90));

describe('explainable activity classifier', () => {
  it('extracts speed, acceleration, stay, distance, elevation and sampling features', () => {
    const features = extractActivityFeatures([
      { t: 0, speed: 0, distance: 0, dt: 0, elevationChange: 0 },
      { t: 5_000, speed: 2, distance: 10, dt: 5_000, elevationChange: 3 },
      { t: 10_000, speed: 4, distance: 10, dt: 5_000, elevationChange: -1 },
      { t: 15_000, speed: 0, distance: 0, dt: 5_000, elevationChange: 0 },
      { t: 20_000, speed: 1, distance: 5, dt: 5_000, elevationChange: 2 }
    ]);

    expect(features).toMatchObject({
      sampleCount: 5, movingSamples: 3, timedSamples: 4, invalidSamples: 0,
      durationMs: 20_000, distanceM: 25, elevationGainM: 5, elevationLossM: 1,
      gradePct: 20, medianSpeed: 2, p90Speed: 4, maxSpeed: 4,
      stayMs: 5_000, stoppedRatio: 0.25, medianIntervalMs: 5_000,
      maxIntervalMs: 5_000, sparseRatio: 0
    });
    expect(features.meanAbsAcceleration).toBeCloseTo(0.45);
    expect(features.p90AbsAcceleration).toBeCloseTo(0.8);
  });

  it('derives intervals from timestamps without inventing them for legacy numeric samples', () => {
    const timed = extractActivityFeatures([
      { t: 1_000, speed: 1 }, { t: 6_000, speed: 1.2 }, { t: 11_000, speed: 1.4 }
    ]);
    expect(timed.medianIntervalMs).toBe(5_000);
    expect(timed.durationMs).toBe(10_000);

    const legacy = extractActivityFeatures([1, 1.2, 1.4, 1.5, 1.6, 1.7]);
    expect(legacy).toMatchObject({
      durationMs: null, distanceM: null, elevationGainM: null, elevationLossM: null,
      meanAbsAcceleration: null, stayMs: null, medianIntervalMs: null
    });
  });

  it.each([
    ['hike', HIKING],
    ['run', RUNNING],
    ['bike', CYCLING],
    ['drive', DRIVING],
    ['travel', TRAVEL]
  ])('ranks %s with confidence and human-readable evidence', (expected, samples) => {
    const result = classifyActivityDetailed(samples);
    expect(result.activity).toBe(expected);
    expect(result.lowConfidence).toBe(false);
    expect(result.confidence).toBeGreaterThanOrEqual(ACTIVITY_CONFIDENCE_THRESHOLD);
    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.map((candidate) => candidate.activity)).toEqual(
      expect.arrayContaining(['hike', 'run', 'bike', 'drive', 'travel'])
    );
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
    expect(result.candidates[0].reasons.some((reason) => reason.code === 'speed')).toBe(true);
    expect(result.reasons.every((reason) => reason.message.length > 0)).toBe(true);
  });

  it('uses steep measured elevation to support a trail activity', () => {
    const steep = series(Array(20).fill(1.2), { elevationChange: 1 });
    const result = classifyActivityDetailed(steep);
    expect(result.activity).toBe('hike');
    expect(result.features.gradePct).toBeGreaterThan(15);
    expect(result.reasons.some((reason) => reason.code === 'elevation')).toBe(true);
    expect(result.confidence).toBeGreaterThan(classifyActivityDetailed(HIKING).confidence);
  });

  it('recognises stop-and-go driving from stops, speed and measured distance', () => {
    const stopGo = series([0, 0, 12, 12, 0, 0, 15, 15, 0, 0, 13, 13, 0, 0, 14, 14, 0, 0, 12, 12]);
    const result = classifyActivityDetailed(stopGo);
    expect(result.activity).toBe('drive');
    expect(result.features.stoppedRatio).toBeGreaterThan(0.4);
    expect(result.features.stayMs).toBeGreaterThan(0);
    expect(result.reasons.some((reason) => reason.code === 'stops')).toBe(true);
  });

  it('does not infer an activity from stationary samples', () => {
    const result = classifyActivityDetailed(series(Array(20).fill(0)));
    expect(result.activity).toBeNull();
    expect(result.lowConfidence).toBe(true);
    expect(result.features.movingSamples).toBe(0);
    expect(result.reasons.some((reason) => reason.code === 'stationary')).toBe(true);
    expect(classifyActivity(Array(20).fill(0))).toBeNull();
  });

  it('derives acceleration from sampling intervals even without timestamps', () => {
    const features = extractActivityFeatures([
      { speed: 1, dt: 0 }, { speed: 2, dt: 5_000 }, { speed: 4, dt: 5_000 }
    ]);
    expect(features.meanAbsAcceleration).toBeCloseTo(0.3);
    expect(features.medianIntervalMs).toBe(5_000);
  });

  it('keeps partially unknown elevation context null', () => {
    const features = extractActivityFeatures(series(Array(20).fill(1.3)), { elevationGainM: 20 });
    expect(features.elevationGainM).toBe(20);
    expect(features.elevationLossM).toBe(0);
    const unknown = extractActivityFeatures([1, 1, 1, 1, 1, 1], { elevationGainM: 20 });
    expect(unknown.elevationLossM).toBeNull();
  });

  it('does not turn missing movement into a zero-speed explanation', () => {
    const result = classifyActivityDetailed(series(Array(20).fill(0)));
    expect(result.features.medianSpeed).toBeNull();
    expect(result.reasons.some((reason) => reason.code === 'speed' && reason.params.speed === 0)).toBe(false);
    expect(result.confidence).toBeLessThan(ACTIVITY_CONFIDENCE_THRESHOLD);
  });

  it('keeps the current activity when samples are insufficient', () => {
    const result = classifyActivityDetailed(series([1.2, 1.3, 1.4]));
    expect(result.activity).toBeNull();
    expect(result.lowConfidence).toBe(true);
    expect(result.reasons.some((reason) => reason.code === 'insufficient')).toBe(true);
  });

  it('rejects sparse or irregular sampling even when speed looks plausible', () => {
    const sparse = classifyActivityDetailed(series(Array(10).fill(1.3), { intervalMs: 60_000 }));
    const irregular = classifyActivityDetailed([
      ...series(Array(8).fill(1.3), { intervalMs: 5_000 }),
      { t: 200_000, speed: 1.3, dt: 160_000, distance: 208 }
    ]);
    for (const result of [sparse, irregular]) {
      expect(result.activity).toBeNull();
      expect(result.lowConfidence).toBe(true);
      expect(result.confidence).toBeLessThan(ACTIVITY_CONFIDENCE_THRESHOLD);
      expect(result.reasons.some((reason) => reason.code === 'sparse')).toBe(true);
    }
  });

  it('ignores impossible, negative and missing speeds instead of poisoning the ranking', () => {
    const samples = [1.2, 1.3, 1.4, Number.NaN, 300, -2, null, Number.POSITIVE_INFINITY] as unknown as number[];
    const result = classifyActivityDetailed(samples);
    expect(result.features.invalidSamples).toBe(5);
    expect(result.activity).toBeNull();
    expect(result.lowConfidence).toBe(true);
  });

  it('returns low confidence for an ambiguous bike/driving-like speed', () => {
    const result = classifyActivityDetailed(series(Array(20).fill(4.5)));
    expect(result.activity).toBeNull();
    expect(result.lowConfidence).toBe(true);
    expect(result.candidates[0].score - result.candidates[1].score).toBeLessThan(0.2);
    expect(result.reasons.some((reason) => reason.code === 'ambiguous')).toBe(true);
  });

  it('uses measured context elevation when per-sample altitude is unavailable', () => {
    const result = classifyActivityDetailed(series(Array(20).fill(1.3)), {
      elevationGainM: 180,
      elevationLossM: 20
    });
    expect(result.features.elevationGainM).toBe(180);
    expect(result.features.elevationLossM).toBe(20);
    expect(result.activity).toBe('hike');
  });

  it('preserves the legacy activity-only API for usable speed arrays', () => {
    expect(classifyActivity(Array(6).fill(1.5))).toBe('hike');
    expect(classifyActivity(Array(6).fill(2.8))).toBe('run');
    expect(classifyActivity(Array(6).fill(90))).toBe('travel');
    expect(classifyActivity([1.5, 1.5, 1.5, 300, 300, 300])).toBeNull();
  });
});
