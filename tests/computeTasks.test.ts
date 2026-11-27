import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { runComputeTask } from '../src/worker/computeTasks';

const full = {
  trip: { id: 't1', name: 'Worker & <Track>', activity: 'hike' },
  segments: [{
    id: 's1', index: 0,
    points: [{ lat: 30, lon: 120, alt: 50, t: 1 }, { lat: 30.001, lon: 120.001, alt: 52, t: 2 }]
  }],
  waypoints: [{ lat: 30.0005, lon: 120.0005, name: 'Sunset', desc: 'view', type: 'custom', hidden: false }]
};

describe('compute worker task dispatch', () => {
  it('serializes GeoJSON and KML without the DOM', async () => {
    const geo = await runComputeTask('geojson', { full, opts: {} });
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.features[0].geometry.coordinates).toEqual([[120, 30, 50], [120.001, 30.001, 52]]);
    expect(geo.features[1].properties.kind).toBe('waypoint');

    const kml = await runComputeTask('kml', { full });
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('Worker &amp; &lt;Track&gt;');
    expect(kml).toContain('120.0000000,30.0000000,50.0');
  });

  it('computes annual reports and resampled profiles', async () => {
    const entries = [{
      trip: { id: 't1', name: 'Annual', activity: 'hike', createdAt: Date.UTC(2026, 4, 1) },
      stats: { distance: 12000, duration: 3_600_000, activeMs: 3_600_000, movingMs: 3_600_000, stillMs: 0, breakMs: 0, ascent: 500, descent: 500, avgSpeed: 3.3 }
    }];
    const report = await runComputeTask('annual-report', { entries, year: 2026, options: {} });
    expect(report.year).toBe(2026);
    expect(report.totals.distance).toBe(12000);

    const stats = { series: { d: [0, 100, 200], alt: [10, 20, null], speed: [1, 2, 3] } };
    const profile = await runComputeTask('profile', { stats, units: 'metric', maxPoints: 1800 });
    expect(profile.x).toEqual([0, 0.1, 0.2]);
    expect(profile.alt).toEqual([10, 20, null]);
    expect(profile.hasSpeed).toBe(true);
  });

  it('builds a checksummed backup archive', async () => {
    const manifest = {
      format: 'localtrace-backup', version: 3,
      exportedAt: '2026-11-27T00:00:00.000Z',
      counts: { trips: 1, segments: 1, trackChunks: 1, waypoints: 0, media: 0 },
      trips: [{ id: 't1' }], waypoints: [], mediaMeta: []
    };
    const archive = await runComputeTask('backup-archive', { manifest, media: [], password: '' });
    expect(archive.filename).toBe('roametch-backup-20261127.trip');
    expect(archive.encrypted).toBe(false);
    expect(archive.tripCount).toBe(1);
    const entries = unzipSync(new Uint8Array(await archive.blob.arrayBuffer()));
    const written = JSON.parse(strFromU8(entries['manifest.json']));
    expect(written.integrity.algo).toBe('SHA-256');
    expect(written.integrity.payload).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unknown task types', () => {
    expect(() => runComputeTask('nope', {})).toThrow('unknown task nope');
  });
});
