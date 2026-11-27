import { describe, expect, it } from 'vitest';
import { activeTripFilterCount, canonicalTripFilterValue, emptyTripFilters, filterTripIndexes, hasActiveTripFilters, indexTripForFilters, localDayKey, placeKey, tripFilterDisplayValue, tripFilterRouteOptions } from '../src/core/tripFilters';

function entry(overrides: any = {}, counts: any = {}) {
  return indexTripForFilters({
    id: 'trip', name: '山脊徒步', activity: 'hike', favorite: true,
    createdAt: new Date(2026, 10, 27, 12).getTime(), tags: ['周末'],
    statsCache: { distance: 12_000, ascent: 800, duration: 7_200_000, activeMs: 6_000_000, completeness: 0.92 },
    places: [{ name: '杭州', countryCode: 'CN', admin: '浙江' }],
    ...overrides
  }, counts);
}

describe('advanced trip filters', () => {
  it('combines every predicate with AND semantics', () => {
    const rows = [
      entry({ id: 'match' }, { hasPhotos: true, waypointCount: 3 }),
      entry({ id: 'no-photo' }, { hasPhotos: false, waypointCount: 3 }),
      entry({ id: 'wrong-activity', activity: 'bike' }, { hasPhotos: true, waypointCount: 3 }),
      entry({ id: 'too-short', statsCache: { distance: 1000, ascent: 800, completeness: 0.92 } }, { hasPhotos: true, waypointCount: 3 })
    ];
    const result = filterTripIndexes(rows, {
      ...emptyTripFilters(), activity: 'hike', favoriteOnly: true, query: '山脊',
      minDistance: 10_000, maxDistance: 20_000, minAscent: 500, maxAscent: 1000,
      hasPhotos: 'yes', minWaypoints: 2, minCompleteness: 90, place: 'cn'
    });
    expect(result.map((row) => row.trip.id)).toEqual(['match']);
  });

  it('includes both local date boundaries and handles cross-year trips', () => {
    const rows = [
      entry({ id: 'before', createdAt: new Date(2025, 11, 31, 23, 59).getTime() }),
      entry({ id: 'start', createdAt: new Date(2026, 0, 1, 0, 0).getTime() }),
      entry({ id: 'end', createdAt: new Date(2026, 0, 1, 23, 59).getTime() }),
      entry({ id: 'after', createdAt: new Date(2026, 0, 2, 0, 0).getTime() })
    ];
    const result = filterTripIndexes(rows, { ...emptyTripFilters(), fromDate: '2026-01-01', toDate: '2026-01-01' });
    expect(result.map((row) => row.trip.id)).toEqual(['start', 'end']);
  });

  it('accepts ISO creation dates without hiding undated trips from non-date filters', () => {
    const iso = new Date(2026, 10, 27, 12).toISOString();
    const rows = [
      entry({ id: 'iso', createdAt: iso }),
      entry({ id: 'missing', createdAt: null }),
      entry({ id: 'invalid', createdAt: 'not-a-date' })
    ];
    expect(filterTripIndexes(rows, emptyTripFilters())).toHaveLength(3);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), query: '山脊' })).toHaveLength(3);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), fromDate: '2026-11-27', toDate: '2026-11-27' })
      .map((row) => row.trip.id)).toEqual(['iso']);
  });

  it('keeps canonical SI thresholds stable across display-unit switches', () => {
    const rows = [entry({ statsCache: { distance: 1609.344, ascent: 304.8, completeness: 1 } })];
    const distanceM = canonicalTripFilterValue(1, 'distance', 'imperial');
    const ascentM = canonicalTripFilterValue(1000, 'ascent', 'imperial');
    expect(distanceM).toBeCloseTo(1609.344, 6);
    expect(ascentM).toBeCloseTo(304.8, 6);
    expect(tripFilterDisplayValue(distanceM, 'distance', 'imperial')).toBe('1');
    expect(tripFilterDisplayValue(ascentM, 'ascent', 'metric')).toBe('304.8');

    const metricRoundTrip = canonicalTripFilterValue(
      Number(tripFilterDisplayValue(distanceM, 'distance', 'metric')), 'distance', 'metric');
    expect(metricRoundTrip).toBeCloseTo(distanceM, 6);
    const filters = { ...emptyTripFilters(), minDistance: distanceM, maxDistance: distanceM, minAscent: ascentM, maxAscent: ascentM };
    expect(filterTripIndexes(rows, filters).map((row) => row.trip.id)).toEqual(['trip']);
    expect(filterTripIndexes(rows, { ...filters, minDistance: 1610 }).map((row) => row.trip.id)).toEqual([]);
  });

  it('disambiguates same-name places by country code', () => {
    const rows = [
      entry({ id: 'cn', places: [{ name: 'Springfield', countryCode: 'US' }] }),
      entry({ id: 'au', places: [{ name: 'Springfield', countryCode: 'AU' }] })
    ];
    expect(placeKey(rows[0].places[0])).toBe('US:springfield');
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), place: 'AU' }).map((row) => row.trip.id)).toEqual(['au']);
  });

  it('supports photo absence, node thresholds, unknown metrics and route references', () => {
    const rows = [
      entry({ id: 'plain' }, { hasPhotos: false, waypointCount: 0 }),
      entry({ id: 'documented', routeId: 'route-a' }, { hasPhotos: true, waypointCount: 4 }),
      entry({ id: 'unknown', statsCache: null })
    ];
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), hasPhotos: 'no' }).map((row) => row.trip.id)).toEqual(['plain']);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), minWaypoints: 4, routeId: 'route-a' }).map((row) => row.trip.id)).toEqual(['documented']);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), minCompleteness: 50 })).toHaveLength(2);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), minDistance: 1000 }).map((row) => row.trip.id)).toEqual(['plain', 'documented']);
  });

  it('ignores invalid negative or non-finite bounds and clamps completeness', () => {
    const rows = [entry()];
    expect(filterTripIndexes(rows, {
      ...emptyTripFilters(), minDistance: -1, maxDistance: Number.NaN,
      minAscent: Number.POSITIVE_INFINITY, minWaypoints: -5
    })).toHaveLength(1);
    expect(filterTripIndexes(rows, { ...emptyTripFilters(), minCompleteness: 200 })).toHaveLength(0);
  });

  it('normalizes ratio and percentage completeness and local day keys', () => {
    expect(entry({ statsCache: { completeness: 83 } }).completeness).toBe(83);
    expect(entry({ statsCache: { quality: { completeness: 0.83 } } }).completeness).toBe(83);
    expect(localDayKey(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
    expect(localDayKey(NaN)).toBe('');
  });
});
