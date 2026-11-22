import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShareLink, parseShareFragment } from '../src/core/shareLink';

afterEach(() => vi.unstubAllGlobals());

function makeFull() {
  const points = Array.from({ length: 60 }, (_, i) => ({
    lat: 30 + Math.sin(i / 8) * 0.002,
    lon: 120 + i * 0.0003
  }));
  return {
    trip: { name: 'Ridge loop', activity: 'hike' },
    segments: [{ id: 's1', points }],
    waypoints: [
      { name: 'Viewpoint', type: 'view', lat: 30.002, lon: 120.01, hidden: false },
      { name: 'Hidden camp', type: 'stay', lat: 30.001, lon: 120.02, hidden: true }
    ]
  };
}

describe('compact share links', () => {
  it('round-trips a simplified track and visible waypoints', () => {
    vi.stubGlobal('location', { href: 'https://example.com/TrackMint/' });
    const { url, size } = buildShareLink(makeFull(), { radius: 0, hideSensitive: true });
    expect(url.startsWith('https://example.com/TrackMint/#t=')).toBe(true);
    expect(size).toBeLessThanOrEqual(1500);
    expect(url.length).toBeLessThan(1800);

    const parsed = parseShareFragment(url.slice(url.indexOf('#')));
    expect(parsed).not.toBeNull();
    expect(parsed.name).toBe('Ridge loop');
    expect(parsed.activity).toBe('hike');
    expect(parsed.points.length).toBeGreaterThan(1);
    expect(parsed.points.length).toBeLessThanOrEqual(60);
    expect(parsed.waypoints).toEqual([{ name: 'Viewpoint', type: 'view', lat: 30.002, lon: 120.01 }]);
  });

  it('rejects malformed fragments instead of throwing', () => {
    expect(parseShareFragment('')).toBeNull();
    expect(parseShareFragment('#t=!')).toBeNull();
    expect(parseShareFragment('#t=zAAAA')).toBeNull();
    expect(parseShareFragment('#nope')).toBeNull();
  });
});
