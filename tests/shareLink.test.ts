import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildShareLink, parseShareFragment, shareFragmentFingerprint } from '../src/core/shareLink';
import { computeStats } from '../src/core/stats';

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
    vi.stubGlobal('location', { href: 'https://example.com/RoamEtch/' });
    const { url, size } = buildShareLink(makeFull(), { radius: 0, hideSensitive: true });
    expect(url.startsWith('https://example.com/RoamEtch/#t=')).toBe(true);
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

  it('preserves segment breaks instead of drawing cross-segment jumps', () => {
    vi.stubGlobal('location', { href: 'https://example.com/RoamEtch/' });
    const full = {
      trip: { name: 'Split drive', activity: 'drive' },
      segments: [
        { id: 'a', points: [{ lat: 30, lon: 120, t: 0 }, { lat: 30, lon: 120.001, t: 10_000 }] },
        { id: 'b', points: [{ lat: 30, lon: 120.05, t: 20_000 }, { lat: 30, lon: 120.051, t: 30_000 }] }
      ],
      waypoints: []
    };
    const stats = computeStats(full.segments, { activity: 'drive' });
    const { url } = buildShareLink(full, { radius: 0, hideSensitive: true });
    const parsed = parseShareFragment(url.slice(url.indexOf('#')));
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.reportedDistance).toBe(Math.round(stats.distance));
    expect(parsed.distance).toBeLessThan(250);
    expect(parsed.distance).toBeGreaterThan(150);
  });

  it('keeps every segment represented when many short tracks exceed the normal point cap', () => {
    vi.stubGlobal('location', { href: 'https://example.com/RoamEtch/' });
    const segments = Array.from({ length: 131 }, (_, i) => ({
      id: `s${i}`,
      points: [{ lat: 30, lon: 120 + i * 0.001, t: 0 }, { lat: 30, lon: 120.0005 + i * 0.001, t: 10_000 }]
    }));
    const { url } = buildShareLink({ trip: { name: 'Many segments', activity: 'drive' }, segments, waypoints: [] }, { radius: 0, hideSensitive: true });
    const parsed = parseShareFragment(url.slice(url.indexOf('#')));
    expect(parsed.segments).toHaveLength(131);
    expect(parsed.points).toHaveLength(262);
  });

  it('bounds large-track preview work while preserving endpoints and segment shape', () => {
    vi.stubGlobal('location', { href: 'https://example.com/RoamEtch/' });
    const points = Array.from({ length: 20_000 }, (_, i) => ({
      lat: 30 + Math.sin(i / 200) * 0.002,
      lon: 120 + i * 0.00001,
      t: i * 1000
    }));
    const { url } = buildShareLink({
      trip: { name: 'Large preview', activity: 'hike' },
      segments: [{ id: 'large', points }],
      waypoints: []
    }, { radius: 0, hideSensitive: true });

    const parsed = parseShareFragment(url.slice(url.indexOf('#')));
    expect(parsed?.points.length).toBeGreaterThan(1);
    expect(parsed?.points.length).toBeLessThanOrEqual(262);
    expect(parsed?.points[0]).toEqual({ lat: 30, lon: 120 });
    expect(parsed?.points.at(-1)?.lon).toBeCloseTo(120.19999, 5);
  });

  it('rejects malformed fragments instead of throwing', () => {
    expect(parseShareFragment('')).toBeNull();
    expect(parseShareFragment('#t=!')).toBeNull();
    expect(parseShareFragment('#t=zAAAA')).toBeNull();
    expect(parseShareFragment('#nope')).toBeNull();
  });
});

describe('share fragment fingerprints', () => {
  function fragmentFor(full = makeFull()) {
    vi.stubGlobal('location', { href: 'https://example.com/RoamEtch/' });
    const { url } = buildShareLink(full, { radius: 0, hideSensitive: true });
    return url.slice(url.indexOf('#'));
  }

  it('is stable for repeated reads of the same fragment', async () => {
    const fragment = fragmentFor();
    const first = await shareFragmentFingerprint(fragment);
    expect(first).toEqual(expect.any(String));
    expect(await shareFragmentFingerprint(fragment)).toBe(first);
  });

  it('changes when imported trip content changes', async () => {
    const base = await shareFragmentFingerprint(fragmentFor());
    const renamed = makeFull();
    renamed.trip.name = 'Different ridge';
    const moved = makeFull();
    moved.segments[0].points[30].lat += 0.01;
    const waypoint = makeFull();
    waypoint.waypoints[0].name = 'Different viewpoint';

    expect(await shareFragmentFingerprint(fragmentFor(renamed))).not.toBe(base);
    expect(await shareFragmentFingerprint(fragmentFor(moved))).not.toBe(base);
    expect(await shareFragmentFingerprint(fragmentFor(waypoint))).not.toBe(base);
  });

  it('returns null for malformed fragments', async () => {
    await expect(shareFragmentFingerprint('')).resolves.toBeNull();
    await expect(shareFragmentFingerprint('#t=!')).resolves.toBeNull();
    await expect(shareFragmentFingerprint('#t=zAAAA')).resolves.toBeNull();
    await expect(shareFragmentFingerprint('#nope')).resolves.toBeNull();
  });
});
