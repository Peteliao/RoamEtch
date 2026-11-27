import { describe, expect, it } from 'vitest';
import { buildHeatmap, createHeatmapAccumulator, mergeHeatmaps, sampleSegmentsByDistance } from '../src/core/heatmap';
import { haversine } from '../src/core/geo';

const R = 6371008.8;
const point = (metres: number, extra: any = {}) => ({ lat: 0, lon: metres / R * 180 / Math.PI, ...extra });
const full = (id: string, points: any[], privacy: any = { radius: 0 }) => ({
  trip: { id, privacy }, segments: [{ id: `${id}-s`, points }]
});

describe('personal history heatmap', () => {
  it('samples by distance instead of raw fix density and respects the budget', () => {
    const dense = Array.from({ length: 1000 }, (_, index) => point(index * 2));
    const sparse = [point(0), point(1998)];
    const denseSamples = sampleSegmentsByDistance([{ id: 'a', points: dense }], 11);
    const sparseSamples = sampleSegmentsByDistance([{ id: 'a', points: sparse }], 11);
    expect(denseSamples).toHaveLength(sparseSamples.length);
    denseSamples.forEach((sample, index) => {
      expect(sample.lat).toBeCloseTo(sparseSamples[index].lat, 8);
      expect(sample.lon).toBeCloseTo(sparseSamples[index].lon, 8);
    });
    expect(denseSamples).toHaveLength(11);
  });

  it('aggregates weighted grid cells and merges trip identity', () => {
    const a = buildHeatmap([full('a', [point(0), point(1000), point(2000)])], { maxPoints: 21 });
    const b = buildHeatmap([full('b', [point(0), point(1000), point(2000)])], { maxPoints: 21 });
    const merged = mergeHeatmaps([a, b]);
    expect(merged.stats.tripCount).toBe(2);
    expect(merged.stats.gridCells).toBe(a.stats.gridCells);
    expect(merged.features.every((feature) => feature.properties.trips === 2)).toBe(true);
    expect(merged.features[0].properties.weight).toBe(a.features[0].properties.weight * 2);
    expect(merged.bbox).not.toBeNull();
    const accumulator = createHeatmapAccumulator();
    accumulator.add(a);
    accumulator.add(b);
    expect(accumulator.result()).toEqual(merged);
  });

  it('interpolates short antimeridian edges without crossing the globe', () => {
    const result = buildHeatmap([full('dateline', [point(0, { lon: 179.99 }), point(0, { lon: -179.99 })])], { maxPoints: 21 });
    expect(result.features.length).toBeGreaterThan(0);
    expect(result.features.every((feature) => Math.abs(feature.geometry.coordinates[0]) > 179.9)).toBe(true);
    expect(result.bbox?.[0]).toBeGreaterThan(179);
    expect(result.bbox?.[2]).toBeLessThan(-179);
  });

  it('keeps adjacent antimeridian cells distinct and merges equivalent ±180 fixes', () => {
    const adjacent = buildHeatmap([full('edges', [
      point(0, { lon: 179.9996 }), point(0, { lon: -179.9996 })
    ])], { maxPoints: 2, gridSize: 0.001 });
    expect(adjacent.features).toHaveLength(2);
    expect(adjacent.features.reduce((sum, feature) => sum + feature.properties.weight, 0)).toBe(2);
    expect(adjacent.bbox?.[0]).toBeCloseTo(179.9995, 7);
    expect(adjacent.bbox?.[2]).toBeCloseTo(-179.9995, 7);

    const equivalent = buildHeatmap([full('seam', [
      point(0, { lon: 180 }), point(100, { lon: -180 })
    ])], { maxPoints: 2, gridSize: 0.001 });
    expect(equivalent.features).toHaveLength(1);
    expect(equivalent.features[0].properties.weight).toBe(2);
  });

  it('applies endpoint privacy circles before aggregation', () => {
    const result = buildHeatmap([full('private', [point(0), point(500), point(1000), point(1500), point(2000)], { radius: 300 })], { maxPoints: 101 });
    expect(result.stats.croppedPoints).toBeGreaterThan(0);
    expect(result.features.every((feature) => {
      const [lon, lat] = feature.geometry.coordinates;
      return haversine(lat, lon, 0, 0) > 300 && haversine(lat, lon, 0, point(2000).lon) > 300;
    })).toBe(true);
  });

  it('never connects across recording gaps and handles empty or stationary tracks', () => {
    const segmented = buildHeatmap([{ trip: { id: 'gap', privacy: { radius: 0 } }, segments: [
      { id: 'a', points: [point(0), point(100)] },
      { id: 'b', points: [point(10_000), point(10_100)] }
    ] }], { maxPoints: 4 });
    expect(segmented.features.some((feature) => feature.geometry.coordinates[0] > 0.05 && feature.geometry.coordinates[0] < 0.09)).toBe(false);
    expect(buildHeatmap([full('still', [point(0), point(0)])]).features).toEqual([]);
    expect(buildHeatmap([]).bbox).toBeNull();
  });
});
