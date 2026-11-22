import { describe, expect, it } from 'vitest';
import { gcj02ToWgs84, isInMainlandChina, toDisplay, fromDisplay, wgs84ToGcj02 } from '../src/core/coords';

describe('coordinate datum conversion', () => {
  it('recognises mainland China, Hainan and overseas points', () => {
    expect(isInMainlandChina(39.9042, 116.4074)).toBe(true);
    expect(isInMainlandChina(19.2, 109.7)).toBe(true);
    expect(isInMainlandChina(48.8566, 2.3522)).toBe(false);
    expect(isInMainlandChina(35.6762, 139.6503)).toBe(false);
  });

  it('converts WGS-84 to GCJ-02 with the standard offset', () => {
    const [lon, lat] = wgs84ToGcj02(116.404, 39.915);
    expect(lon).toBeCloseTo(116.41024449916938, 5);
    expect(lat).toBeCloseTo(39.91640428150164, 5);
  });

  it('round-trips inside mainland China to sub-metre precision', () => {
    for (const [lon, lat] of [[116.404, 39.915], [121.4737, 31.2304], [109.7, 19.2]]) {
      const [gLon, gLat] = wgs84ToGcj02(lon, lat);
      const [wLon, wLat] = gcj02ToWgs84(gLon, gLat);
      expect(wLon).toBeCloseTo(lon, 6);
      expect(wLat).toBeCloseTo(lat, 6);
    }
  });

  it('leaves points outside the fence untouched', () => {
    expect(wgs84ToGcj02(2.3522, 48.8566)).toEqual([2.3522, 48.8566]);
    expect(gcj02ToWgs84(139.6503, 35.6762)).toEqual([139.6503, 35.6762]);
  });

  it('only offsets display coordinates on a GCJ-02 basemap', () => {
    const point = [116.404, 39.915];
    expect(toDisplay(point[0], point[1], 'WGS84')).toEqual(point);
    const displayed = toDisplay(point[0], point[1], 'GCJ02');
    expect(displayed).not.toEqual(point);
    const [lon, lat] = fromDisplay(displayed[0], displayed[1], 'GCJ02');
    expect(lon).toBeCloseTo(point[0], 6);
    expect(lat).toBeCloseTo(point[1], 6);
  });
});
