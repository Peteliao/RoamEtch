import { describe, expect, it } from 'vitest';
import { buildFootprints } from '../src/core/footprint';

function trip(createdAt, distance, ascent = 100, duration = 3600_000) {
  return { createdAt, statsCache: { distance, ascent, duration } };
}

describe('footprint statistics', () => {
  const trips = [
    trip(new Date(2026, 0, 3).getTime(), 10_000),
    trip(new Date(2026, 0, 20).getTime(), 15_000, 300),
    trip(new Date(2026, 5, 8).getTime(), 25_000, 500),
    trip(new Date(2025, 11, 31).getTime(), 5_000, 50)
  ];

  it('aggregates annual totals and active days', () => {
    const { current } = buildFootprints(trips, new Date(2026, 10, 22));
    expect(current.year).toBe(2026);
    expect(current.trips).toBe(3);
    expect(current.distance).toBe(50_000);
    expect(current.ascent).toBe(900);
    expect(current.days).toBe(3);
    expect(current.months[0].trips).toBe(2);
    expect(current.months[5].distance).toBe(25_000);
  });

  it('lists available years newest first and keeps empty months', () => {
    const { years, current } = buildFootprints(trips, new Date(2026, 10, 22));
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
    expect(current.months).toHaveLength(12);
    expect(current.months[11].trips).toBe(0);
  });

  it('handles an empty library', () => {
    const { years, current } = buildFootprints([], new Date(2026, 10, 22));
    expect(years).toEqual([]);
    expect(current.trips).toBe(0);
    expect(current.months).toHaveLength(12);
  });
});
