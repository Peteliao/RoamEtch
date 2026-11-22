// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildGeoJSON, buildGPX, buildKML, parseGPX } from '../src/core/gpx';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Morning hike</name></metadata>
  <wpt lat="30.2" lon="120.2"><ele>88</ele><name>Spring</name><desc>Water point</desc><time>2024-01-01T01:00:00Z</time></wpt>
  <trk>
    <name>Track A</name>
    <trkseg>
      <trkpt lat="30.1" lon="120.1"><ele>100</ele><time>2024-01-01T00:00:00Z</time></trkpt>
      <trkpt lat="30.101" lon="120.101"><ele>102.5</ele><time>2024-01-01T00:01:00Z</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="30.102" lon="120.102"><ele>104</ele><time>2024-01-01T00:02:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('GPX parsing', () => {
  it('reads metadata, multiple segments, elevations, times and waypoints', () => {
    const parsed = parseGPX(SAMPLE);
    expect(parsed.name).toBe('Morning hike');
    expect(parsed.hasTime).toBe(true);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0][0]).toMatchObject({ lat: 30.1, lon: 120.1, alt: 100, altSrc: 'svc' });
    expect(parsed.segments[0][1].alt).toBe(102.5);
    expect(parsed.segments[0][0].t).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(parsed.waypoints).toHaveLength(1);
    expect(parsed.waypoints[0]).toMatchObject({
      lat: 30.2, lon: 120.2, name: 'Spring', desc: 'Water point', type: 'custom', alt: 88
    });
  });

  it('falls back to route points and rejects empty or invalid documents', () => {
    const route = parseGPX(`<gpx><rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="1.1" lon="2.1"/></rte></gpx>`);
    expect(route.name).toBe('R');
    expect(route.segments[0]).toHaveLength(2);
    expect(route.hasTime).toBe(false);

    expect(() => parseGPX('<gpx></gpx>')).toThrow('no track data');
    expect(() => parseGPX('<gpx><trk>')).toThrow('XML parse error');
  });
});

describe('track exports', () => {
  const full = {
    trip: { name: 'Ridge & Loop', activity: 'hike', createdAt: 1_700_000_000_000 },
    segments: [
      { id: 's1', points: [{ lat: 30, lon: 120, alt: 100, t: 1_700_000_000_000 }, { lat: 30.001, lon: 120.001, alt: 101, t: 1_700_000_060_000 }] },
      { id: 's2', points: [{ lat: 30.002, lon: 120.002, alt: 102, t: 1_700_000_120_000 }, { lat: 30.003, lon: 120.003, alt: 103, t: 1_700_000_180_000 }] }
    ],
    waypoints: [{ lat: 30.0005, lon: 120.0005, alt: 99, name: 'Spring <1>', desc: 'A & B', time: null, hidden: false, type: 'view' }]
  };

  it('writes a GPX document that parses back', () => {
    const parsed = parseGPX(buildGPX(full));
    expect(parsed.name).toBe('Ridge & Loop');
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[0]).toHaveLength(2);
    expect(parsed.waypoints[0].name).toBe('Spring <1>');
  });

  it('writes GeoJSON as [lon, lat, alt] and keeps waypoints', () => {
    const geo = buildGeoJSON(full);
    expect(geo.type).toBe('FeatureCollection');
    expect(geo.features).toHaveLength(3);
    expect(geo.features[0].geometry.coordinates[0]).toEqual([120, 30, 100]);
    expect(geo.features[2].properties.kind).toBe('waypoint');
  });

  it('writes KML with a valid colour and escaped names', () => {
    const kml = buildKML(full);
    expect(kml).toContain('<color>ffa7cd2b</color>');
    expect(kml).toContain('Ridge &amp; Loop');
    expect((kml.match(/<LineString>/g) || [])).toHaveLength(2);
  });
});
