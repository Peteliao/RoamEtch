// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildSelfContainedHTML } from '../src/core/htmlExport';
import { VIEWER_JS } from '../src/core/htmlExportViewer';

function full() {
  return {
    trip: { id: 't1', name: 'Two halves', activity: 'hike', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
    segments: [
      {
        id: 's1',
        points: [
          { lat: 30, lon: 120, t: 1_700_000_000_000, alt: 100 },
          { lat: 30.001, lon: 120.001, t: 1_700_000_060_000, alt: 110 },
          { lat: 30.002, lon: 120.002, t: 1_700_000_120_000, alt: 120 }
        ]
      },
      {
        id: 's2',
        points: [
          { lat: 30.003, lon: 120.003, t: 1_700_000_180_000, alt: 130 },
          { lat: 30.004, lon: 120.004, t: 1_700_000_240_000, alt: 140 }
        ]
      }
    ],
    waypoints: [
      { id: 'w1', name: 'Viewpoint', type: 'view', lat: 30.001, lon: 120.001, time: 1_700_000_060_000, desc: 'Open ridge', mediaIds: [] }
    ],
    media: []
  };
}

function embedded(html: string) {
  const match = html.match(/window\.__TRIP__=(.*?);<\/script>/s);
  if (!match) throw new Error('embedded data missing');
  return JSON.parse(match[1]);
}

describe('self-contained HTML export', () => {
  it('keeps route discontinuities, style and independent icon privacy in v4 data', async () => {
    const { html } = await buildSelfContainedHTML(full(), {
      tier: 'clear',
      places: ['Ridge'],
      style: { trackColor: 'rose', trackWidth: 9.5, title: 'Evening' },
      privacy: { radius: 0, hideStartIcon: true },
      includePhotos: false
    });
    const data = embedded(html);
    expect(data.v).toBe(4);
    expect(data.segs).toHaveLength(2);
    expect(data.segs[0].length).toBeGreaterThanOrEqual(2);
    expect(data.segs[1]).toHaveLength(2);
    expect(data.pts).toHaveLength(4);
    expect(data.hideStart).toBe(true);
    expect(data.hideEnd).toBe(false);
    expect(data.trackColor).toBe('#f472b6');
    expect(data.trackWidth).toBe(9.5);
    expect(data.wps[0].n).toBe('Viewpoint');
    expect(data.wps[0].de).toBe('Open ridge');
    expect(data.wps[0].pr).toBeGreaterThan(0);
    expect(data.profiles.speed.length).toBeGreaterThanOrEqual(2);
    expect(data.profiles.slope).toEqual([]);
    expect(data.gaps).toHaveLength(1);
    expect(data.gaps[0].kind).toBe('recording');
    expect(data.labels).toMatchObject({ close: expect.any(String), previous: expect.any(String), next: expect.any(String) });
  });

  it('leaves theme-colored tracks to the active palette', async () => {
    const { html } = await buildSelfContainedHTML(full(), {
      tier: 'light',
      places: ['Ridge'],
      style: { trackColor: 'theme' },
      privacy: { radius: 0, hideEndIcon: true },
      includePhotos: false
    });
    const data = embedded(html);
    expect(data.trackColor).toBe('');
    expect(data.hideStart).toBe(false);
    expect(data.hideEnd).toBe(true);
  });

  it('does not accumulate missing distance across segment boundaries', async () => {
    const input = full();
    input.waypoints.push({ id: 'w2', name: 'Second segment', type: 'custom', lat: 30.003, lon: 120.003, time: 1_700_000_180_000, desc: '', mediaIds: [] });
    const { html } = await buildSelfContainedHTML(input, { places: [], privacy: { radius: 0 }, includePhotos: false });
    const data = embedded(html);
    const node = data.wps.find((waypoint) => waypoint.n === 'Second segment');
    expect(node.dst).toBe('294 m');
    expect(node.pr).toBeGreaterThan(0.6);
    expect(node.pr).toBeLessThan(0.75);
  });

  it('projects waypoint distance onto line segments instead of the nearest fix', async () => {
    const input = full();
    input.waypoints = [{ id: 'mid', name: 'Mid-edge', type: 'custom', lat: 30.0005, lon: 120.0005, time: 1_700_000_030_000, desc: '', mediaIds: [] }];
    const { html } = await buildSelfContainedHTML(input, { places: [], privacy: { radius: 0 }, includePhotos: false });
    const node = embedded(html).wps[0];
    const distance = Number.parseFloat(node.dst);
    expect(distance).toBeGreaterThan(70);
    expect(distance).toBeLessThan(90);
    expect(node.pr).toBeGreaterThan(0.1);
    expect(node.pr).toBeLessThan(0.25);
  });

  it('keeps displayed distance and waypoint progress on the final exported geometry', async () => {
    const start = 1_700_000_000_000;
    const input = {
      trip: { id: 'geometry', name: 'Geometry', activity: 'hike', createdAt: start, updatedAt: start + 120_000 },
      segments: [{ id: 's1', points: [
        { lat: 30, lon: 120, t: start, alt: 100 },
        { lat: 30.001, lon: 120.002, t: start + 1_000, alt: 110 },
        { lat: 30.002, lon: 120, t: start + 120_000, alt: 120 }
      ] }],
      waypoints: [{ id: 'mid', name: 'Retained fix', type: 'custom', lat: 30.001, lon: 120.002, time: start + 1_000, desc: '', mediaIds: [] }],
      media: []
    };
    const { html } = await buildSelfContainedHTML(input, { places: [], privacy: { radius: 0 }, includePhotos: false });
    const data = embedded(html);
    expect(data.distance).toBeGreaterThan(400);
    expect(Number.parseFloat(data.wps[0].dst)).toBeGreaterThan(200);
    expect(data.wps[0].pr).toBeGreaterThan(0.45);
    expect(data.wps[0].pr).toBeLessThan(0.55);
    expect(data.profiles.elevation.at(-1)[0]).toBeCloseTo(data.distance, 0);
  });

  it('uses waypoint time to choose the correct overlapping out-and-back branch', async () => {
    const start = 1_700_000_000_000;
    const input = {
      trip: { id: 'overlap', name: 'Out and back', activity: 'hike', createdAt: start, updatedAt: start + 600_000 },
      segments: [{ id: 'out-back', points: [
        { lat: 30, lon: 120, t: start, alt: 100 },
        { lat: 30, lon: 120.01, t: start + 200_000, alt: 110 },
        { lat: 30, lon: 120.01, t: start + 400_000, alt: 110 },
        { lat: 30, lon: 120, t: start + 600_000, alt: 100 }
      ] }],
      waypoints: [{ id: 'return', name: 'Returning', type: 'view', lat: 30, lon: 120.005, time: start + 500_000, mediaIds: [] }],
      media: []
    };
    const { html } = await buildSelfContainedHTML(input, { places: [], privacy: { radius: 0 }, includePhotos: false });
    expect(embedded(html).wps[0].pr).toBeCloseTo(0.75, 2);
  });

  it('labels privacy breaks separately and keeps them unconnected in ends-only mode', async () => {
    const center = { lat: 30, lon: 120 };
    const input = {
      trip: { id: 'loop', name: 'Loop', activity: 'hike', createdAt: 1_700_000_000_000, updatedAt: 1_700_001_000_000 },
      segments: [{ id: 'loop', points: [120, 120.005, 120.01, 120.005, 120, 120.005, 120.01]
        .map((lon, index) => ({ lat: 30, lon, t: 1_700_000_000_000 + index * 60_000, alt: 100 + index })) }],
      waypoints: [],
      media: []
    };
    const options = { radius: 300, start: center, end: { lat: 30.03, lon: 120 } };
    const all = embedded((await buildSelfContainedHTML(input, { places: [], privacy: options, includePhotos: false })).html);
    expect(all.gaps.length).toBeGreaterThan(0);
    expect(all.gaps.every((gap) => gap.kind === 'privacy')).toBe(true);

    const ends = await buildSelfContainedHTML(input, { places: [], privacy: { ...options, mode: 'ends', offset: true }, includePhotos: false });
    expect(embedded(ends.html).gaps).toHaveLength(0);
    expect(ends.html).not.toContain('id="gapConnect"');
  });

  it('ships a parseable dependency-free viewer script', () => {
    expect(VIEWER_JS).toContain('function setReplay');
    expect(VIEWER_JS).toContain('function openLightbox');
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.close)");
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.previous)");
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.next)");
    expect(() => new Function(VIEWER_JS)).not.toThrow();
  });
});
