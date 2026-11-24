import { describe, expect, it } from 'vitest';
import { altitudeInUnit, buildProfile, distanceInUnit, speedInUnit } from '../src/core/profileChart';

const stats = {
  series: {
    d: [0, 1000, 2000, 3000],
    alt: [100, 110, null, 130],
    speed: [1, 2, 3, 4]
  }
};

describe('combined profile chart data', () => {
  it('converts distance, altitude and speed to imperial units', () => {
    expect(distanceInUnit(1609.344, 'imperial')).toBeCloseTo(1);
    expect(altitudeInUnit(1, 'imperial')).toBeCloseTo(3.28084);
    expect(speedInUnit(1, 'imperial')).toBeCloseTo(2.23694);
    const profile = buildProfile(stats, 'imperial');
    expect(profile.x[1]).toBeCloseTo(0.621371);
    expect(profile.alt[1]).toBeCloseTo(360.8924);
    expect(profile.speed[3]).toBeCloseTo(8.94776);
    expect(profile.hasAlt).toBe(true);
    expect(profile.hasSpeed).toBe(true);
  });

  it('keeps source indices while sampling and preserves the final point', () => {
    const many = {
      series: {
        d: Array.from({ length: 101 }, (_, i) => i * 10),
        alt: Array.from({ length: 101 }, (_, i) => i),
        speed: Array.from({ length: 101 }, (_, i) => i / 10)
      }
    };
    const profile = buildProfile(many, 'metric', 12);
    expect(profile.x.length).toBeLessThanOrEqual(13);
    expect(profile.sourceIndices[0]).toBe(0);
    expect(profile.sourceIndices.at(-1)).toBe(100);
    expect(profile.sourceIndices.every((value, i) => value === 0 || value > profile.sourceIndices[i - 1])).toBe(true);
  });

  it('keeps null gaps and detects a missing series', () => {
    const profile = buildProfile(stats);
    expect(profile.alt[2]).toBeNull();
    const altitudeOnly = buildProfile({ series: { ...stats.series, speed: [null, null, null, null] } });
    expect(altitudeOnly.hasSpeed).toBe(false);
    expect(altitudeOnly.speedRange).toBeNull();
    expect(altitudeOnly.altRange).not.toBeNull();
  });

  it('handles empty tracks and constant series safely', () => {
    const empty = buildProfile({ series: { d: [], alt: [], speed: [] } });
    expect(empty.hasAlt).toBe(false);
    expect(empty.hasSpeed).toBe(false);
    expect(empty.maxX).toBeGreaterThan(0);
    const constant = buildProfile({ series: { d: [0, 1], alt: [20, 20], speed: [0, 0] } });
    expect(constant.altRange!.max).toBeGreaterThan(constant.altRange!.min);
    expect(constant.speedRange!.max).toBeGreaterThan(0);
  });
});
