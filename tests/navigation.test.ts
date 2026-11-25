import { describe, expect, it } from 'vitest';
import { navigationLinks, navigationMode } from '../src/core/navigation';
import { wgs84ToGcj02 } from '../src/core/coords';

describe('external re-walk navigation', () => {
  it('routes mainland destinations through Amap with GCJ-02 coordinates', () => {
    const links = navigationLinks(30.25, 120.15, 230_000, '杭州 & 迹刻');
    expect(links?.provider).toBe('amap');
    expect(links?.mode).toBe('driving');
    const url = new URL(links!.fallback);
    expect(url.origin + url.pathname).toBe('https://uri.amap.com/navigation');
    expect(url.searchParams.get('mode')).toBe('car');
    expect(url.searchParams.get('coordinate')).toBe('gaode');
    expect(url.searchParams.get('dname')).toBe('杭州 & 迹刻');
    expect(url.searchParams.has('from')).toBe(false);
    const [lon, lat] = url.searchParams.get('to')!.split(',').map(Number);
    const [expectedLon, expectedLat] = wgs84ToGcj02(120.15, 30.25);
    expect(lon).toBeCloseTo(expectedLon, 5);
    expect(lat).toBeCloseTo(expectedLat, 5);
  });

  it('uses native Amap routes on mobile with a web fallback', () => {
    const ios = navigationLinks(30.25, 120.15, 500, '起点', 'ios')!;
    expect(ios.primary.startsWith('iosamap://path?')).toBe(true);
    expect(new URL(ios.primary).searchParams.get('t')).toBe('2');
    expect(ios.fallback.startsWith('https://uri.amap.com/navigation?')).toBe(true);

    const android = navigationLinks(30.25, 120.15, 3000, '起点', 'android')!;
    expect(android.primary.startsWith('androidamap://route?')).toBe(true);
    expect(new URL(android.primary).searchParams.get('t')).toBe('0');
  });

  it('uses Google Maps without an origin outside mainland China', () => {
    const links = navigationLinks(37.7749, -122.4194, 20_000, 'Trip', 'web')!;
    const url = new URL(links.primary);
    expect(links.provider).toBe('google');
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/');
    expect(url.searchParams.get('destination')).toBe('37.774900,-122.419400');
    expect(url.searchParams.get('travelmode')).toBe('driving');
    expect(url.searchParams.get('dir_action')).toBe('navigate');
    expect(url.searchParams.has('origin')).toBe(false);
  });

  it('selects walking guidance for short approaches and rejects invalid coordinates', () => {
    expect(navigationMode(1999)).toBe('walking');
    expect(navigationMode(2000)).toBe('driving');
    expect(navigationLinks(NaN, 120, 100)).toBeNull();
    expect(navigationLinks(91, 120, 100)).toBeNull();
    expect(navigationLinks(30, 181, 100)).toBeNull();
    expect(navigationLinks(30, 120, -1)).toBeNull();
  });
});
