// Batch trip transfer: ZIP of per-trip GPX/GeoJSON out, multi-file GPX/ZIP in.
import { Zip, ZipDeflate, Unzip, UnzipInflate, strToU8 } from 'fflate';
import { loadTripFull } from './store';
import { buildGPX, buildGeoJSON, importGPXFile } from './gpx';

const safeName = (s) => String(s || 'trip').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_GPX_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_QUEUE_BYTES = 4 * 1024 * 1024;
const signatureOf = (bytes: Uint8Array) => String.fromCharCode(...bytes);

export async function exportTripsZip(ids, format = 'gpx') {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let count = 0;
  let zipError: unknown = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.byteLength) chunks.push(chunk);
  });
  try {
    for (const id of ids) {
      const full = await loadTripFull(id);
      if (!full) continue;
      const base = `${safeName(full.trip.name)}-${id.slice(0, 8)}`;
      const path = format === 'geojson' ? `${base}.geojson` : `${base}.gpx`;
      const bytes = strToU8(format === 'geojson' ? JSON.stringify(buildGeoJSON(full)) : buildGPX(full));
      const entry = new ZipDeflate(path, { level: 6 });
      zip.add(entry);
      for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
        entry.push(bytes.subarray(offset, offset + 1024 * 1024));
      }
      entry.push(new Uint8Array(), true);
      if (zipError) throw zipError;
      count++;
    }
    zip.end();
    if (zipError) throw zipError;
  } catch (error) {
    zip.terminate();
    throw error;
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return { blob: new Blob(chunks, { type: 'application/zip' }), filename: `roametch-trips-${stamp}.zip`, count };
}

interface ZipGpxEntry {
  name: string;
  chunks: AsyncIterable<Uint8Array>;
}

interface ZipEntryState {
  name: string;
  queue: Uint8Array[];
  bytes: number;
  done: boolean;
  error: unknown;
  file: { terminate: () => void };
}

async function* streamZipGpx(
  file: Blob,
  options: { signal?: AbortSignal }
): AsyncGenerator<ZipGpxEntry> {
  const reader = file.stream().getReader();
  const pending: ZipEntryState[] = [];
  let current: ZipEntryState | null = null;
  let entryCount = 0;
  let failure: unknown = null;
  let queuedBytes = 0;
  let archiveDone = false;
  let prefix = new Uint8Array(4);
  let prefixLength = 0;
  let prefixChecked = false;
  const unzip = new Unzip((entry) => {
    if (++entryCount > MAX_ZIP_ENTRIES) throw new Error('too many archive entries');
    if (failure) {
      entry.ondata = () => {};
      entry.start();
      return;
    }
    if (!/\.(gpx|xml)$/i.test(entry.name)) {
      entry.ondata = (error) => { if (error) failure = error; };
      entry.start();
      return;
    }
    if (entry.originalSize != null && entry.originalSize > MAX_ZIP_GPX_BYTES) {
      throw new Error('archive entry too large');
    }
    const state: ZipEntryState = {
      name: entry.name.replace(/\.(gpx|xml)$/i, ''),
      queue: [], bytes: 0, done: false, error: null, file: entry
    };
    entry.ondata = (error, data, final) => {
      if (error) {
        state.error = error;
        failure = error;
        return;
      }
      state.bytes += data.byteLength;
      if (state.bytes > MAX_ZIP_GPX_BYTES || queuedBytes + data.byteLength > MAX_ZIP_QUEUE_BYTES) {
        state.error = new Error(state.bytes > MAX_ZIP_GPX_BYTES ? 'archive entry too large' : 'archive queue too large');
        failure = state.error;
        entry.ondata = () => {};
        return;
      }
      state.queue.push(data);
      queuedBytes += data.byteLength;
      if (final) state.done = true;
    };
    entry.start();
    pending.push(state);
  });
  unzip.register(UnzipInflate);

  const pump = async () => {
    if (archiveDone) return;
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    const { done, value } = await reader.read();
    if (!done && prefixLength < prefix.length) {
      const take = Math.min(prefix.length - prefixLength, value.byteLength);
      prefix.set(value.subarray(0, take), prefixLength);
      prefixLength += take;
    }
    if (!prefixChecked && prefixLength === prefix.length) {
      prefixChecked = true;
      const signature = signatureOf(prefix);
      if (!['PK\u0003\u0004', 'PK\u0005\u0006', 'PK\u0007\u0008'].includes(signature)) throw new Error('not a zip');
    }
    unzip.push(done ? new Uint8Array() : value, done);
    if (failure) throw failure;
    if (done) {
      archiveDone = true;
      if (!entryCount && signatureOf(prefix) !== 'PK\u0005\u0006') throw new Error('not a zip');
      if (current && !current.done && !current.error) current.error = new Error('truncated archive');
      for (const state of pending) {
        if (!state.done && !state.error) state.error = new Error('truncated archive');
      }
    }
  };

  const chunksOf = async function* (state: ZipEntryState) {
    let exhausted = false;
    try {
      while (true) {
        if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        if (state.error) throw state.error;
        if (state.queue.length) {
          const chunk = state.queue.shift()!;
          queuedBytes -= chunk.byteLength;
          yield chunk;
          continue;
        }
        if (state.done) {
          exhausted = true;
          return;
        }
        await pump();
      }
    } finally {
      if (!exhausted && !options.signal?.aborted) {
        while (!state.done && !state.error && !archiveDone) await pump();
      }
    }
  };

  try {
    while (true) {
      while (!pending.length && !archiveDone) await pump();
      if (!pending.length) break;
      const state = pending.shift()!;
      current = state;
      yield { name: state.name, chunks: chunksOf(state) };
      current = null;
    }
  } finally {
    current?.file.terminate();
    for (const state of pending) state.file.terminate();
    if (!archiveDone) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Accepts loose .gpx/.xml files and ZIP archives containing them. */
export async function importTripFiles(files, options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {}) {
  let ok = 0;
  let fail = 0;
  const importOne = async (name: string, input: Blob | AsyncIterable<Uint8Array>, singlePass = false) => {
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    try {
      await importGPXFile(input, name, { ...options, singlePass });
      ok++;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      fail++;
    }
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        for await (const entry of streamZipGpx(f, options)) {
          await importOne(entry.name, entry.chunks, true);
        }
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        fail++;
      }
    } else {
      await importOne(f.name.replace(/\.(gpx|xml)$/i, ''), f);
    }
  }
  return { ok, fail };
}
