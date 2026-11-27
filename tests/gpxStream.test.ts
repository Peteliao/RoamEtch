// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_GPX_STREAM_BYTES, streamGPX, type GPXStreamEvent } from '../src/core/gpxStream';

function chunkedBlob(text: string, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  return {
    size: bytes.byteLength,
    stream: () => new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
        }
        controller.close();
      }
    })
  } as Blob;
}

async function collect(text: string, chunkSize = 7) {
  const events: GPXStreamEvent[] = [];
  const summary = await streamGPX(chunkedBlob(text, chunkSize), (event) => { events.push(event); });
  return { events, summary };
}

describe('streaming GPX parser', () => {
  it('handles split UTF-8, namespaces, entities, CDATA and bounded point batches', async () => {
    const points = Array.from({ length: 1001 }, (_, index) =>
      `<trkpt lat="${30 + index / 100000}" lon="${120 + index / 100000}"><ele>${index}</ele><time>2024-01-01T00:${String(index % 60).padStart(2, '0')}:00Z</time></trkpt>`
    ).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <g:gpx xmlns:g="http://www.topografix.com/GPX/1/1">
        <g:metadata><g:name>山 &amp; 水</g:name></g:metadata>
        <g:wpt lat="30" lon="120"><g:name><![CDATA[起点 <1> &amp;]]></g:name><g:desc>A &lt; B</g:desc></g:wpt>
        <g:trk><g:trkseg>${points}</g:trkseg></g:trk>
      </g:gpx>`;
    const { events, summary } = await collect(xml);
    const batches = events.filter((event) => event.type === 'points') as Extract<GPXStreamEvent, { type: 'points' }>[];
    expect(summary).toMatchObject({ name: '山 & 水', segments: 1, waypoints: 1, hasTime: true });
    expect(batches.length).toBe(3);
    expect(Math.max(...batches.map((event) => event.points.length))).toBeLessThanOrEqual(400);
    expect(batches.reduce((sum, event) => sum + event.points.length, 0)).toBe(1001);
    const waypoints = events.find((event) => event.type === 'waypoints') as Extract<GPXStreamEvent, { type: 'waypoints' }>;
    expect(waypoints.waypoints[0]).toMatchObject({ name: '起点 <1> &amp;', desc: 'A < B' });
  });

  it('prefers tracks over routes and rejects out-of-range coordinates', async () => {
    const { events, summary } = await collect(`<gpx>
      <rte><name>Route</name><rtept lat="1" lon="2"/></rte>
      <trk><name>Track</name><trkseg>
        <trkpt lat="91" lon="2"/><trkpt lat="1" lon="181"/><trkpt lat="1" lon="2"><ele>0</ele></trkpt>
      </trkseg></trk>
    </gpx>`);
    expect(summary.name).toBe('Track');
    const points = events.find((event) => event.type === 'points') as Extract<GPXStreamEvent, { type: 'points' }>;
    expect(points.points).toHaveLength(1);
    expect(points.points[0]).toMatchObject({ lat: 1, lon: 2, alt: 0 });
  });

  it('reports the earliest valid track timestamp across out-of-order segments', async () => {
    const { summary } = await collect(`<gpx><trk>
      <trkseg><trkpt lat="1" lon="2"><time>2024-01-01T00:10:00Z</time></trkpt></trkseg>
      <trkseg><trkpt lat="2" lon="3"><time>invalid</time></trkpt><trkpt lat="3" lon="4"><time>2023-12-31T23:55:00Z</time></trkpt></trkseg>
    </trk></gpx>`);
    expect(summary.startTime).toBe(Date.parse('2023-12-31T23:55:00Z'));
  });

  it('imports route-only documents and implicit track points', async () => {
    const route = await collect('<gpx><rte><name>R</name><rtept lat="1" lon="2"/><rtept lat="2" lon="3"/></rte></gpx>');
    expect(route.summary).toMatchObject({ name: 'R', segments: 1, hasTime: false });
    const implicit = await collect('<gpx><trk><trkpt lat="1" lon="2"/><trkpt lat="2" lon="3"/></trk></gpx>');
    expect(implicit.summary.segments).toBe(1);
  });

  it('bounds implicit track batches and keeps points before explicit segments', async () => {
    const implicitPoints = Array.from({ length: 1001 }, (_, index) =>
      `<trkpt lat="${30 + index / 100000}" lon="120"/>`
    ).join('');
    const events: GPXStreamEvent[] = [];
    const progress: number[] = [];
    const blob = chunkedBlob(`<gpx><trk>${implicitPoints}<trkseg><trkpt lat="31" lon="121"/></trkseg></trk></gpx>`);
    const summary = await streamGPX(blob, (event) => { events.push(event); }, {
      onProgress: (loaded, total) => {
        expect(total).toBe(blob.size);
        progress.push(loaded);
      }
    });
    const batches = events.filter((event) => event.type === 'points') as Extract<GPXStreamEvent, { type: 'points' }>[];
    expect(summary.segments).toBe(1);
    expect(batches).toHaveLength(3);
    expect(Math.max(...batches.map((event) => event.points.length))).toBeLessThanOrEqual(400);
    expect(batches.flatMap((event) => event.points)).toHaveLength(1002);
    expect(batches.at(-1)?.points.at(-1)).toMatchObject({ lat: 31, lon: 121 });
    expect(progress.at(-1)).toBe(blob.size);
    expect(progress.every((loaded, index) => index === 0 || loaded >= progress[index - 1])).toBe(true);
  });

  it('keeps self-closing fields empty and preserves literal CDATA entities', async () => {
    const { events } = await collect(`<gpx>
      <wpt lat="1" lon="2"><ele/><time>2024-01-01T00:00:00Z</time><name/><desc>hello</desc></wpt>
      <trk><trkseg><trkpt lat="3" lon="4"><ele/><time>2024-01-01T00:01:00Z</time></trkpt></trkseg></trk>
    </gpx>`);
    const waypoint = (events.find((event) => event.type === 'waypoints') as Extract<GPXStreamEvent, { type: 'waypoints' }>).waypoints[0];
    const point = (events.find((event) => event.type === 'points') as Extract<GPXStreamEvent, { type: 'points' }>).points[0];
    expect(waypoint).toMatchObject({ name: '', desc: 'hello', alt: null, time: Date.parse('2024-01-01T00:00:00Z') });
    expect(point).toMatchObject({ alt: null, t: Date.parse('2024-01-01T00:01:00Z') });
  });

  it('supports single-pass async bytes while retaining track-over-route precedence metadata', async () => {
    const bytes = new TextEncoder().encode(`<gpx>
      <rte><name>Route</name><rtept lat="1" lon="2"/></rte>
      <trk><name>Track</name><trkseg><trkpt lat="3" lon="4"/></trkseg></trk>
      <rte><rtept lat="5" lon="6"/></rte>
    </gpx>`);
    const input = (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 5) yield bytes.slice(offset, offset + 5);
    })();
    const events: GPXStreamEvent[] = [];
    const summary = await streamGPX(input, (event) => { events.push(event); }, { singlePass: true });
    const batches = events.filter((event) => event.type === 'points') as Extract<GPXStreamEvent, { type: 'points' }>[];
    expect(summary.name).toBe('Track');
    expect(batches.map((event) => event.source)).toEqual(['route', 'track']);
    expect(batches.flatMap((event) => event.points)).toHaveLength(2);
    await expect(streamGPX((async function* () { yield bytes; })(), () => {})).rejects.toThrow('single-pass');
  });

  it('resets route timestamps when a later track takes precedence', async () => {
    const bytes = new TextEncoder().encode(`<gpx>
      <rte><rtept lat="1" lon="2"><time>2020-01-01T00:00:00Z</time></rtept></rte>
      <trk><trkpt lat="3" lon="4"><time>2024-01-01T00:00:00Z</time></trkpt><trkpt lat="3.1" lon="4.1"><time>2023-12-31T23:00:00Z</time></trkpt></trk>
    </gpx>`);
    const input = (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 5) yield bytes.subarray(offset, offset + 5);
    })();
    const summary = await streamGPX(input, () => {}, { singlePass: true });
    expect(summary.startTime).toBe(Date.parse('2023-12-31T23:00:00Z'));
  });

  it('bounds oversized XML tokens and total streamed input', async () => {
    await expect(collect(`<gpx><!--${'x'.repeat(1024 * 1024)}`, 64 * 1024)).rejects.toThrow('XML token too large');
    const bytes = new Uint8Array(MAX_GPX_STREAM_BYTES + 1);
    const input = (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 16 * 1024 * 1024) {
        yield bytes.subarray(offset, Math.min(bytes.length, offset + 16 * 1024 * 1024));
      }
    })();
    await expect(streamGPX(input, () => {}, { singlePass: true })).rejects.toThrow('GPX input too large');
  }, 15_000);

  it('rejects malformed or empty XML and supports cancellation', async () => {
    await expect(collect('<gpx><trk>')).rejects.toThrow('XML parse error');
    await expect(collect('<gpx/>')).rejects.toThrow('no track data');
    const controller = new AbortController();
    controller.abort();
    await expect(streamGPX(chunkedBlob('<gpx><trkpt lat="1" lon="2"/></gpx>'), () => {}, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
