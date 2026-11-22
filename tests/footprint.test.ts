import { describe, expect, it } from 'vitest';
import { buildFootprints, recapFootprint } from '../src/core/footprint';

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

describe('footprint share recap', () => {
  const { current } = buildFootprints([
    { createdAt: new Date(2026, 0, 3).getTime(), statsCache: { distance: 12_000, ascent: 100 } },
    { createdAt: new Date(2026, 0, 20).getTime(), statsCache: { distance: 8_000, ascent: 300 } },
    { createdAt: new Date(2026, 5, 8).getTime(), statsCache: { distance: 25_000, ascent: 500 } }
  ], new Date(2026, 10, 22));

  it('summarises totals, active months and the biggest month', () => {
    const r = recapFootprint(current, 'metric');
    expect(r.distance).toEqual({ v: '45.00', u: 'km' });
    expect(r.ascent).toEqual({ v: '900', u: 'm' });
    expect(r.activeMonths).toBe(2);
    expect(r.topMonth.month).toBe(6);
    expect(r.maxMonthDistance).toBe(25_000);
  });

  it('converts units and handles an empty year', () => {
    const r = recapFootprint(current, 'imperial');
    expect(r.distance.u).toBe('mi');
    expect(r.ascent.u).toBe('ft');

    const { current: empty } = buildFootprints([], new Date(2026, 10, 22));
    const e = recapFootprint(empty, 'metric');
    expect(e.activeMonths).toBe(0);
    expect(e.topMonth).toBeNull();
    expect(e.maxMonthDistance).toBe(1);
  });
});
