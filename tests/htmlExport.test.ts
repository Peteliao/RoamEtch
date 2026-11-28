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
          { lat: 30.001, lon: 120.001, t: 1_700_000_001_000, alt: 110 },
          { lat: 30.002, lon: 120.002, t: 1_700_000_002_000, alt: 120 }
        ]
      },
      {
        id: 's2',
        points: [
          { lat: 30.003, lon: 120.003, t: 1_700_000_003_000, alt: 130 },
          { lat: 30.004, lon: 120.004, t: 1_700_000_004_000, alt: 140 }
        ]
      }
    ],
    waypoints: [
      { id: 'w1', name: 'Viewpoint', type: 'view', lat: 30.001, lon: 120.001, time: 1_700_000_001_000, desc: 'Open ridge', mediaIds: [] }
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
  it('keeps route discontinuities, style and independent icon privacy in v3 data', async () => {
    const { html } = await buildSelfContainedHTML(full(), {
      tier: 'clear',
      places: ['Ridge'],
      style: { trackColor: 'rose', trackWidth: 9.5, title: 'Evening' },
      privacy: { radius: 0, hideStartIcon: true },
      includePhotos: false
    });
    const data = embedded(html);
    expect(data.v).toBe(3);
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

  it('ships a parseable dependency-free viewer script', () => {
    expect(VIEWER_JS).toContain('function setReplay');
    expect(VIEWER_JS).toContain('function openLightbox');
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.close)");
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.previous)");
    expect(VIEWER_JS).toContain("setAttribute('aria-label',L.next)");
    expect(() => new Function(VIEWER_JS)).not.toThrow();
  });
});
