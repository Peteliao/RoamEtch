import { describe, expect, it } from 'vitest';
import { simulateTrack, type SimulatedFix } from '../src/core/simulation';
import { computeStats } from '../src/core/stats';

describe('large trajectory simulation', () => {
  it.each([100_000, 500_000, 1_000_000])('streams %i fixes without materializing the track', (count) => {
    const sampleMs = 1000;
    const started = performance.now();
    let generated = 0;
    let lastT = 0;
    for (const item of simulateTrack({
      scenario: 'hike',
      durationMs: (count - 1) * sampleMs,
      sampleMs,
      startTime: 1000,
      seed: 11
    })) {
      if (item.kind !== 'fix') continue;
      generated++;
      lastT = item.fix.t;
    }
    const elapsed = performance.now() - started;

    expect(generated).toBe(count);
    expect(lastT).toBe(1000 + (count - 1) * sampleMs);
    expect(elapsed).toBeLessThan(20_000);
    console.info(`simulation scale: ${count.toLocaleString()} fixes in ${elapsed.toFixed(1)} ms`);
  }, 30_000);

  it.each([100_000, 500_000, 1_000_000])('summarizes a %i-point generated track without chart series', (count) => {
    const points: SimulatedFix[] = [];
    for (const item of simulateTrack({
      scenario: 'hike',
      durationMs: (count - 1) * 1000,
      sampleMs: 1000,
      startTime: 1000,
      seed: 11
    })) {
      if (item.kind === 'fix') points.push(item.fix);
    }
    const started = performance.now();
    const summary = computeStats([{ id: 'scale', points }], { activity: 'hike', series: false });
    const elapsed = performance.now() - started;

    expect(summary.pointCount).toBe(count);
    expect(summary.duration).toBe((count - 1) * 1000);
    expect(summary.distance).toBeGreaterThan(0);
    expect(summary.series).toBeUndefined();
    expect(elapsed).toBeLessThan(20_000);
    console.info(`statistics scale: ${count.toLocaleString()} points in ${elapsed.toFixed(1)} ms`);
  }, 30_000);
});
