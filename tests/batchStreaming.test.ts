// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';

const mocks = vi.hoisted(() => ({
  loadTripFull: vi.fn(),
  buildGPX: vi.fn(),
  buildGeoJSON: vi.fn(),
  importGPXFile: vi.fn()
}));

vi.mock('../src/core/store', () => ({ loadTripFull: mocks.loadTripFull }));
vi.mock('../src/core/gpx', () => ({
  buildGPX: mocks.buildGPX,
  buildGeoJSON: mocks.buildGeoJSON,
  importGPXFile: mocks.importGPXFile
}));

import { exportTripsZip, importTripFiles } from '../src/core/batch';

function streamingFile(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const blob = new Blob([bytes]);
  return {
    name,
    size: blob.size,
    stream: () => blob.stream(),
    arrayBuffer: vi.fn(() => blob.arrayBuffer())
  } as unknown as File;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.importGPXFile.mockImplementation(async (input: Blob | AsyncIterable<Uint8Array>) => {
    if (input instanceof Blob) return input.text();
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of input) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  });
});

describe('streaming batch transfer', () => {
  it('imports GPX entries from a streamed ZIP without materializing the archive', async () => {
    const archive = zipSync({
      'folder/first.gpx': strToU8('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>'),
      'notes.txt': strToU8('ignored'),
      'second.xml': strToU8('<gpx><wpt lat="3" lon="4"/></gpx>')
    });
    const file = streamingFile(archive, 'trips.zip');

    await expect(importTripFiles([file])).resolves.toEqual({ ok: 2, fail: 0 });

    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.importGPXFile).toHaveBeenCalledTimes(2);
    expect(mocks.importGPXFile.mock.calls[0][0]).not.toBeInstanceOf(Blob);
    expect(typeof (mocks.importGPXFile.mock.calls[0][0] as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]).toBe('function');
    expect(mocks.importGPXFile.mock.calls[0][2]).toMatchObject({ singlePass: true });
    expect(mocks.importGPXFile.mock.calls[0][1]).toBe('folder/first');
    expect(mocks.importGPXFile.mock.calls[1][1]).toBe('second');
    expect(await mocks.importGPXFile.mock.results[0].value).toContain('<trkpt');
    expect(await mocks.importGPXFile.mock.results[1].value).toContain('<wpt');
  });

  it('continues after malformed GPX entries by draining their decompressed stream', async () => {
    const archive = zipSync({
      'broken.gpx': strToU8('<gpx><trk>'),
      'valid.gpx': strToU8('<gpx><trk><trkseg><trkpt lat="3" lon="4"/></trkseg></trk></gpx>')
    });
    mocks.importGPXFile.mockImplementationOnce(async (input: Blob | AsyncIterable<Uint8Array>) => {
      if (!(input instanceof Blob)) {
        for await (const _chunk of input) { /* consume a prefix */ break; }
      }
      throw new Error('XML parse error');
    });

    await expect(importTripFiles([streamingFile(archive, 'trips.zip')])).resolves.toEqual({ ok: 1, fail: 1 });
    expect(mocks.importGPXFile.mock.calls[1][1]).toBe('valid');
    expect(await mocks.importGPXFile.mock.results[1].value).toContain('<trkpt');
  });

  it('bounds queued decompression when one input chunk contains multiple GPX entries', async () => {
    const padding = ' '.repeat(3 * 1024 * 1024);
    const archive = zipSync({
      'first.gpx': strToU8(`<gpx><trk><trkseg>${padding}<trkpt lat="1" lon="2"/></trkseg></trk></gpx>`),
      'second.gpx': strToU8(`<gpx><trk><trkseg>${padding}<trkpt lat="3" lon="4"/></trkseg></trk></gpx>`)
    });

    await expect(importTripFiles([streamingFile(archive, 'queued.zip')])).resolves.toEqual({ ok: 0, fail: 1 });
    expect(mocks.importGPXFile).not.toHaveBeenCalled();
  });

  it('cancels a partially consumed ZIP entry without reading the rest of the archive', async () => {
    const archive = zipSync({ 'trip.gpx': strToU8('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>') });
    const controller = new AbortController();
    const file = streamingFile(archive, 'trips.zip');
    mocks.importGPXFile.mockImplementationOnce(async (input: Blob | AsyncIterable<Uint8Array>, _name, options) => {
      if (!(input instanceof Blob)) {
        for await (const _chunk of input) { break; }
      }
      controller.abort();
      throw options.signal.reason;
    });

    await expect(importTripFiles([file], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('counts malformed ZIP archives as failures and preserves cancellation', async () => {
    await expect(importTripFiles([streamingFile(strToU8('not a zip'), 'broken.zip')]))
      .resolves.toEqual({ ok: 0, fail: 1 });
    const controller = new AbortController();
    controller.abort();
    const file = streamingFile(zipSync({ 'trip.gpx': strToU8('<gpx/>') }), 'trips.zip');
    await expect(importTripFiles([file], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(mocks.importGPXFile).not.toHaveBeenCalled();
  });

  it('builds multi-trip ZIP exports incrementally with the existing entry format', async () => {
    mocks.loadTripFull.mockImplementation(async (id: string) => ({
      trip: { id, name: id === 'trip-1' ? 'First trip' : 'Second trip' },
      segments: [], waypoints: []
    }));
    mocks.buildGPX.mockImplementation((full) => `<gpx><name>${full.trip.name}</name></gpx>`);
    mocks.buildGeoJSON.mockImplementation((full) => ({ name: full.trip.name }));

    const result = await exportTripsZip(['trip-1', 'trip-2']);
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));

    expect(result.count).toBe(2);
    expect(result.filename).toMatch(/^roametch-trips-\d{8}\.zip$/);
    expect(Object.keys(files).sort()).toEqual(['First_trip-trip-1.gpx', 'Second_trip-trip-2.gpx']);
    expect(new TextDecoder().decode(files['First_trip-trip-1.gpx'])).toContain('First trip');
  });
});
