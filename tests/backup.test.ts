import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Zip, ZipDeflate, UnzipInflate, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sha256Hex, stableStringify } from '../src/core/integrity';

const mock = vi.hoisted(() => {
  const names = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media', 'elevCache', 'shareImports'];
  const exportNames = names.slice(0, -1);
  const initial = {
    trips: [{ id: 't1', name: 'Test trip' }],
    segments: [{ id: 's1', tripId: 't1', index: 0, points: [] }],
    trackChunks: [],
    trackSnapshots: [],
    waypoints: [],
    media: [{ id: 'm1', tripId: 't1', blob: new Blob([new Uint8Array([1, 2, 3])]) }],
    elevCache: [],
    shareImports: []
  };
  let state;
  let failPut = null;
  let txCalls = 0;
  let activeTransactions = 0;
  let readsInTransaction = [];
  let transactionModes = [];
  let transactionScopes = [];
  const db: any = {};
  const keyOf = (name, row) => name === 'elevCache' ? row.key : name === 'shareImports' ? row.fingerprint : row.id;
  const reset = () => {
    state = Object.fromEntries(names.map((n) => [n, new Map(initial[n].map((r) => [keyOf(n, r), r]))]));
    failPut = null;
    txCalls = 0;
    activeTransactions = 0;
    readsInTransaction = [];
    transactionModes = [];
    transactionScopes = [];
  };
  reset();
  for (const name of names) {
    db[name] = {
      toArray: async () => {
        if (activeTransactions) readsInTransaction.push(name);
        return [...state[name].values()];
      },
      bulkGet: async (ids) => ids.map((id) => state[name].get(id)),
      put: async (row) => {
        if (failPut && failPut.table === name && failPut.match(row)) {
          failPut = null;
          throw new Error('write failed');
        }
        state[name].set(keyOf(name, row), row);
      },
      delete: async (id) => { state[name].delete(id); },
      where: (field) => ({
        equals: (value) => ({
          delete: async () => {
            for (const [id, row] of [...state[name]]) {
              if (row[field] === value) state[name].delete(id);
            }
          }
        })
      })
    };
  }
  db.transaction = async (...args) => {
    const fn = args[args.length - 1];
    const snapshot = new Map(names.map((n) => [n, new Map(state[n])]));
    let aborted = false;
    const transaction: any = {
      active: true,
      abort: () => {
        if (!transaction.active) return;
        transaction.active = false;
        aborted = true;
      }
    };
    txCalls++;
    transactionModes.push(args[0]);
    transactionScopes.push(args[1]);
    activeTransactions++;
    try {
      const result = await fn(transaction);
      await Promise.resolve();
      if (aborted) throw new DOMException('Aborted', 'AbortError');
      transaction.active = false;
      return result;
    } catch (e) {
      transaction.active = false;
      for (const n of names) state[n] = snapshot.get(n);
      throw e;
    } finally {
      activeTransactions--;
    }
  };
  db.__reset = reset;
  db.__state = () => state;
  db.__txCalls = () => txCalls;
  db.__readsInTransaction = () => readsInTransaction;
  db.__transactionModes = () => transactionModes;
  db.__transactionScopes = () => transactionScopes;
  db.__names = () => names;
  db.__exportNames = () => exportNames;
  db.__failNextPut = (table, match = () => true) => { failPut = { table, match }; };
  return { db };
});

vi.mock('../src/core/store', () => ({
  db: mock.db,
  TRIP_SCHEMA_VERSION: 1,
  abortTransactionOnSignal: (transaction: any, signal?: AbortSignal) => {
    if (!signal) return () => {};
    const abort = () => {
      if (!transaction.active) return;
      try { transaction.abort(); } catch { /* commit-wins */ }
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  }
}));
vi.mock('../src/core/events', () => ({ emit: vi.fn() }));

const { exportBackup, inspectBackup, restoreBackup } = await import('../src/core/backup');

function asFile(blob, arrayBuffer = () => blob.arrayBuffer()) {
  return { size: blob.size, arrayBuffer, stream: () => blob.stream() };
}

function validManifest(overrides = {}) {
  return {
    format: 'localtrace-backup', version: 2,
    exportedAt: new Date().toISOString(),
    trips: [], segments: [], trackChunks: [], waypoints: [], mediaMeta: [], elevCache: [],
    ...overrides
  };
}

function zipFile(files) {
  return asFile(new Blob([zipSync(files)]));
}

function descriptorZipFile(files: Record<string, Uint8Array>) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let zipError: unknown = null;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.byteLength) chunks.push(chunk);
  });
  for (const [name, bytes] of Object.entries(files)) {
    const entry = new ZipDeflate(name);
    zip.add(entry);
    entry.push(bytes);
    entry.push(new Uint8Array(), true);
    if (zipError) throw zipError;
  }
  zip.end();
  if (zipError) throw zipError;
  return asFile(new Blob(chunks));
}

async function historicalManifest(version: number) {
  const manifest: any = validManifest({
    version,
    trips: [{ id: 'legacy-trip', name: 'Legacy trip', activity: 'hike', status: 'finished' }],
    segments: [{ id: 'legacy-segment', tripId: 'legacy-trip', index: 0, startTime: 1000, endTime: 2000 }],
    trackChunks: [{
      id: 'legacy-chunk', tripId: 'legacy-trip', segmentId: 'legacy-segment', seq: 0,
      points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
    }],
    waypoints: [{ id: 'legacy-waypoint', tripId: 'legacy-trip', lat: 30, lon: 120, time: 1500, mediaIds: [] }],
    elevCache: [{ key: '30.000,120.000', elevation: 100, fetchedAt: 1 }],
    ...(version === 3 ? {
      tripSchemaVersion: 1,
      trackSnapshots: [{
        id: 'legacy-snapshot', tripId: 'legacy-trip', segmentId: 'legacy-segment', segmentIndex: 0,
        seq: 0, createdAt: 3000,
        points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
      }]
    } : {})
  });
  if (version >= 2) {
    const { integrity, ...payload } = manifest;
    manifest.integrity = { algo: 'SHA-256', payload: await sha256Hex(stableStringify(payload)), files: {} };
  }
  return manifest;
}

function manifestFile(manifest) {
  return zipFile({ 'manifest.json': strToU8(JSON.stringify(manifest)) });
}

function patternedBytes(length: number, seed = 1) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + seed) & 255;
  return bytes;
}

async function archiveWithMedia(media: { id: string; data: Uint8Array; thumb?: Uint8Array }[]) {
  const manifest: any = validManifest({
    trips: [{ id: 't1' }],
    mediaMeta: media.map(({ id }) => ({ id, tripId: 't1', width: 100, height: 80, createdAt: 1 }))
  });
  const entries: Record<string, Uint8Array> = {};
  const hashes = {};
  for (const item of media) {
    const path = `media/${item.id}.jpg`;
    entries[path] = item.data;
    hashes[path] = { bytes: item.data.byteLength, sha256: await sha256Hex(item.data) };
    if (item.thumb) {
      const thumbPath = `media/${item.id}.thumb.jpg`;
      entries[thumbPath] = item.thumb;
      hashes[thumbPath] = { bytes: item.thumb.byteLength, sha256: await sha256Hex(item.thumb) };
    }
  }
  const { integrity, ...payload } = manifest;
  manifest.integrity = { algo: 'SHA-256', payload: await sha256Hex(stableStringify(payload)), files: hashes };
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(entries, { level: 0 })]);
}

function trackedFile(bytes: Uint8Array, { chunkSize = 4093, onRead = null } = {}) {
  let offset = 0;
  let reads = 0;
  const cancel = vi.fn(async () => {});
  const releaseLock = vi.fn();
  const file = {
    size: bytes.byteLength,
    arrayBuffer: vi.fn(async () => bytes.slice().buffer),
    stream: () => ({
      getReader: () => ({
        read: async () => {
          reads++;
          onRead?.(reads);
          if (offset >= bytes.byteLength) return { done: true, value: undefined };
          const end = Math.min(offset + chunkSize, bytes.byteLength);
          const value = bytes.subarray(offset, end);
          offset = end;
          return { done: false, value };
        },
        cancel,
        releaseLock
      })
    })
  };
  return { file, cancel, releaseLock };
}

function localEntryOffset(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 30 <= bytes.byteLength) {
    if (view.getUint32(offset, false) !== 0x504b0304) throw new Error('local entry not found');
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const dataOffset = offset + 30 + nameLength + extraLength;
    const entryName = strFromU8(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (entryName === name) return dataOffset;
    offset = dataOffset + compressedSize;
  }
  throw new Error('local entry not found');
}

function centralEntryOffset(bytes: Uint8Array, name: string) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryName = strFromU8(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entryName === name) return offset;
    offset += 45 + nameLength + extraLength + commentLength;
  }
  throw new Error('central entry not found');
}

beforeEach(() => mock.db.__reset());

describe('backup integrity', () => {
  it('stable-stringifies objects independent of key order', async () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(await sha256Hex('abc')).toHaveLength(64);
  });

  it('exports a checksummed archive that verifies', async () => {
    const backup = await exportBackup();
    expect(backup.tripCount).toBe(1);
    const inspected = await inspectBackup(asFile(backup.blob));
    expect(inspected.manifest.version).toBe(3);
    expect(inspected.integrity.ok).toBe(true);
    expect(inspected.integrity.checked).toBe(1);
    expect(inspected.manifest.counts.media).toBe(1);
  });

  it('reads every exported table inside one read transaction', async () => {
    await exportBackup();

    expect(mock.db.__transactionModes()).toEqual(['r']);
    const tableNames = mock.db.__exportNames();
    expect(new Set(mock.db.__readsInTransaction())).toEqual(new Set(tableNames));
    expect(mock.db.__readsInTransaction()).toHaveLength(tableNames.length);
  });

  it('round-trips original track snapshots in version 3 backups', async () => {
    mock.db.__state().trackSnapshots.set('snapshot-1', {
      id: 'snapshot-1', tripId: 't1', segmentId: 's1', segmentIndex: 0,
      seq: 0, createdAt: 123, points: [{ lat: 30, lon: 120, t: 1 }]
    });
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    expect(inspected.manifest.trackSnapshots).toHaveLength(1);
    await restoreBackup(asFile(backup.blob), 'overwrite', inspected);
    expect(mock.db.__state().trackSnapshots.get('snapshot-1')?.points).toHaveLength(1);
  });

  it('keeps encrypted backups compatible with one-shot AES-GCM decryption', async () => {
    const backup = await exportBackup({ password: 'correct horse battery' });
    expect(backup.encrypted).toBe(true);
    expect(backup.filename).toMatch(/^roametch-backup-\d{8}\.roametch\.enc$/);
    const bytes = new Uint8Array(await backup.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('TRKMBKP1');
    const arrayBuffer = vi.fn(() => backup.blob.arrayBuffer());
    const encryptedFile = asFile(backup.blob, arrayBuffer);
    await expect(inspectBackup(encryptedFile)).rejects.toMatchObject({ code: 'backup-password-required' });
    await expect(inspectBackup(encryptedFile, 'wrong password')).rejects.toMatchObject({ code: 'backup-decrypt-failed' });
    const inspected = await inspectBackup(encryptedFile, 'correct horse battery');
    expect(arrayBuffer).toHaveBeenCalled();
    expect(inspected.encrypted).toBe(true);
    expect(inspected.integrity.ok).toBe(true);
    expect(inspected.files['media/m1.jpg']).toBeInstanceOf(Blob);
    expect(inspected.manifest.trips[0].name).toBe('Test trip');
    const restored = await restoreBackup(encryptedFile, 'overwrite', inspected);
    expect(restored).toBe(1);
  });

  it('detects a modified manifest', async () => {
    const backup = await exportBackup();
    const files = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.trips[0].name = 'tampered';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const tampered = new Blob([zipSync(files)]);
    const inspected = await inspectBackup(asFile(tampered));
    expect(inspected.integrity.ok).toBe(false);
    expect(inspected.integrity.failed).toContain('manifest');
  });

  it('detects modified media bytes', async () => {
    const backup = await exportBackup();
    const files = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    files['media/m1.jpg'] = new Uint8Array([9, 9, 9]);
    const tampered = new Blob([zipSync(files)]);
    const inspected = await inspectBackup(asFile(tampered));
    expect(inspected.integrity.ok).toBe(false);
    expect(inspected.integrity.failed).toContain('media/m1.jpg');
  });

  it('rejects malformed manifests before restore', async () => {
    const manifest = {
      format: 'localtrace-backup', version: 2,
      exportedAt: new Date().toISOString(),
      counts: { trips: 0 },
      trips: [], segments: [], trackChunks: [], waypoints: []
    };
    const malformed = new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })]);
    await expect(inspectBackup(asFile(malformed))).rejects.toThrow('invalid manifest');
  });

  it('accepts legacy version 1 backups without a checksum', async () => {
    const legacy = zipFile({ 'manifest.json': strToU8(JSON.stringify(validManifest({ version: 1 }))) });
    const inspected = await inspectBackup(legacy);
    expect(inspected.integrity.ok).toBe(null);
    expect(inspected.conflicts).toEqual([]);
  });

  it('adds the current trip schema version when restoring legacy records', async () => {
    const manifest: any = validManifest({ version: 2, trips: [{ id: 'legacy-1', name: 'Legacy' }] });
    const { integrity, ...payload } = manifest;
    manifest.integrity = { algo: 'SHA-256', payload: await sha256Hex(stableStringify(payload)), files: {} };
    const legacy = manifestFile(manifest);
    const inspected = await inspectBackup(legacy);
    await restoreBackup(legacy, 'skip', inspected);
    expect(mock.db.__state().trips.get('legacy-1')?.schemaVersion).toBe(1);
  });

  it.each([2, 3])('rejects version %i backups without integrity metadata', async (version) => {
    const manifest = validManifest({ version, ...(version === 3 ? { trackSnapshots: [] } : {}) });
    await expect(inspectBackup(manifestFile(manifest))).rejects.toThrow('invalid manifest');
  });

  it.each([2, 3])('rejects a prepared version %i inspection whose integrity metadata was removed', async (version) => {
    const archive = manifestFile(await historicalManifest(version));
    const inspected = await inspectBackup(archive);
    delete inspected.manifest.integrity;
    await expect(restoreBackup(archive, 'skip', inspected)).rejects.toThrow('invalid manifest');
    expect(mock.db.__state().trips.has('legacy-trip')).toBe(false);
  });

  it.each([2, 3])('rechecks payload integrity when a prepared version %i manifest is mutated', async (version) => {
    const archive = manifestFile(await historicalManifest(version));
    const inspected = await inspectBackup(archive);
    inspected.manifest.trips[0].name = 'tampered after inspection';
    await expect(restoreBackup(archive, 'skip', inspected)).rejects.toThrow('backup integrity check failed');
    expect(mock.db.__state().trips.has('legacy-trip')).toBe(false);
  });

  it('rechecks media integrity when a prepared inspection replaces a Blob', async () => {
    const backup = await exportBackup();
    const archive = asFile(backup.blob);
    const inspected = await inspectBackup(archive);
    const original = mock.db.__state().media.get('m1')?.blob;
    inspected.files['media/m1.jpg'] = new Blob([new Uint8Array([9, 9, 9])]);
    await expect(restoreBackup(archive, 'overwrite', inspected)).rejects.toThrow('backup integrity check failed');
    expect(mock.db.__state().media.get('m1')?.blob).toBe(original);
  });

  it('reverifies and restores Uint8Array media from an older prepared inspection', async () => {
    const backup = await exportBackup();
    const archive = asFile(backup.blob);
    const inspected = await inspectBackup(archive);
    inspected.files['media/m1.jpg'] = new Uint8Array([1, 2, 3]) as any;

    await expect(restoreBackup(archive, 'overwrite', inspected)).resolves.toBe(1);
    const restored = mock.db.__state().media.get('m1')?.blob;
    expect(restored).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await restored.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it.each([1, 2, 3])('restores a complete version %i backup into the current schema', async (version) => {
    const archive = manifestFile(await historicalManifest(version));
    const inspected = await inspectBackup(archive);
    expect(inspected.integrity.ok).toBe(version === 1 ? null : true);
    await expect(restoreBackup(archive, 'skip', inspected)).resolves.toBe(1);

    const state = mock.db.__state();
    expect(state.trips.get('legacy-trip')).toMatchObject({ name: 'Legacy trip', schemaVersion: 1 });
    expect(state.segments.get('legacy-segment')).toMatchObject({ tripId: 'legacy-trip', index: 0 });
    expect(state.trackChunks.get('legacy-chunk')?.points).toHaveLength(2);
    expect(state.waypoints.get('legacy-waypoint')?.time).toBe(1500);
    expect(state.elevCache.get('30.000,120.000')?.elevation).toBe(100);
    expect(state.trackSnapshots.size).toBe(version === 3 ? 1 : 0);
  });

  it('rejects future database and trip schema declarations before restore', async () => {
    const futureDatabase = manifestFile(await historicalManifest(2));
    const databaseManifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(await futureDatabase.arrayBuffer()))['manifest.json']));
    databaseManifest.tripSchemaVersion = 2;
    await expect(inspectBackup(manifestFile(databaseManifest))).rejects.toMatchObject({ code: 'backup-trip-schema-unsupported' });

    const futureTrip = manifestFile(await historicalManifest(2));
    const tripManifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(await futureTrip.arrayBuffer()))['manifest.json']));
    tripManifest.trips[0].schemaVersion = 2;
    await expect(inspectBackup(manifestFile(tripManifest))).rejects.toMatchObject({ code: 'backup-trip-schema-unsupported' });
    expect(mock.db.__state().trips.has('legacy-trip')).toBe(false);
  });

  it('revalidates trip schema versions when a prepared inspection is reused', async () => {
    const archive = manifestFile(await historicalManifest(2));
    const inspected = await inspectBackup(archive);
    inspected.manifest.trips[0].schemaVersion = 2;
    await expect(restoreBackup(archive, 'skip', inspected)).rejects.toMatchObject({ code: 'backup-trip-schema-unsupported' });
    expect(mock.db.__state().trips.has('legacy-trip')).toBe(false);
  });
});

describe('streaming backup import', () => {
  it('bounds every deflate input slice before decompression can allocate output', async () => {
    const backup = await exportBackup();
    const push = vi.spyOn(UnzipInflate.prototype, 'push');
    try {
      await inspectBackup(asFile(backup.blob));
      expect(push).toHaveBeenCalled();
      expect(Math.max(...push.mock.calls.map((call) => call[0].byteLength))).toBeLessThanOrEqual(4096);
    } finally {
      push.mockRestore();
    }
  });

  it('inspects plain ZIPs through stream without arrayBuffer and reuses media Blobs on restore', async () => {
    const backup = await exportBackup();
    const arrayBuffer = vi.fn(() => { throw new Error('whole-file read is not allowed'); });
    const file = asFile(backup.blob, arrayBuffer);
    const onProgress = vi.fn();
    const inspected = await inspectBackup(file, '', { onProgress });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.at(-1)?.[0]).toEqual({ phase: 'read', loaded: file.size, total: file.size });
    expect(inspected.files['media/m1.jpg']).toBeInstanceOf(Blob);
    expect(inspected.integrity.ok).toBe(true);

    await restoreBackup(file, 'overwrite', inspected);
    expect(mock.db.__state().media.get('m1')?.blob).toBe(inspected.files['media/m1.jpg']);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('bounds work per entry while handling multiple large media Blobs', async () => {
    const entryBytes = 7 * 1024 * 1024;
    const archive = await archiveWithMedia([
      { id: 'm1', data: patternedBytes(entryBytes, 1) },
      { id: 'm2', data: patternedBytes(entryBytes, 2), thumb: patternedBytes(1024, 3) },
      { id: 'm3', data: patternedBytes(entryBytes, 4) }
    ]);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const tracked = trackedFile(bytes, { chunkSize: 65521 });
    const inspected = await inspectBackup(tracked.file);

    expect(tracked.file.arrayBuffer).not.toHaveBeenCalled();
    expect(Object.keys(inspected.files)).toHaveLength(4);
    expect(inspected.files['media/m1.jpg'].size).toBe(entryBytes);
    expect(inspected.files['media/m2.jpg'].size).toBe(entryBytes);
    expect(inspected.files['media/m2.thumb.jpg'].size).toBe(1024);
    expect(inspected.files['media/m3.jpg'].size).toBe(entryBytes);
    expect(inspected.integrity).toMatchObject({ ok: true, checked: 4, failed: [] });

    await restoreBackup(tracked.file, 'overwrite', inspected);
    expect(mock.db.__state().media.get('m2')?.blob).toBe(inspected.files['media/m2.jpg']);
    expect(mock.db.__state().media.get('m2')?.thumb).toBe(inspected.files['media/m2.thumb.jpg']);
  });

  it('verifies incremental media hashes across SHA-256 block boundaries', async () => {
    const lengths = [0, 55, 56, 63, 64, 65, 127, 128, 129];
    const archive = await archiveWithMedia(lengths.map((length, index) => ({
      id: `m${index}`,
      data: patternedBytes(length, index + 1)
    })));
    const inspected = await inspectBackup(asFile(archive));
    expect(inspected.integrity).toMatchObject({ ok: true, checked: lengths.length, failed: [] });
  });

  it('cancels a pending reader immediately when aborted', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const cancel = vi.fn(async () => {});
    const releaseLock = vi.fn();
    const file = {
      size: 100,
      stream: () => ({
        getReader: () => ({
          read: () => { markStarted(); return new Promise(() => {}); },
          cancel,
          releaseLock
        })
      })
    };
    const controller = new AbortController();
    const pending = inspectBackup(file, '', { signal: controller.signal });
    await started;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it('cancels the reader and releases its lock when aborted', async () => {
    const backup = await exportBackup();
    const bytes = new Uint8Array(await backup.blob.arrayBuffer());
    const controller = new AbortController();
    const tracked = trackedFile(bytes, {
      chunkSize: Math.max(1, Math.floor(bytes.byteLength / 2)),
      onRead: (read) => { if (read === 2) controller.abort(); }
    });

    await expect(inspectBackup(tracked.file, '', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(tracked.cancel).toHaveBeenCalledOnce();
    expect(tracked.releaseLock).toHaveBeenCalledOnce();
    expect(tracked.file.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a truncated compressed entry and cleans up the stream', async () => {
    const archive = await archiveWithMedia([{ id: 'm1', data: patternedBytes(128 * 1024) }]);
    const bytes = new Uint8Array(await archive.arrayBuffer());
    const mediaOffset = localEntryOffset(bytes, 'media/m1.jpg');
    const truncated = bytes.subarray(0, mediaOffset + 1);
    const tracked = trackedFile(truncated, { chunkSize: 257 });

    await expect(inspectBackup(tracked.file)).rejects.toThrow('not a zip');
    expect(tracked.cancel).toHaveBeenCalledOnce();
    expect(tracked.releaseLock).toHaveBeenCalledOnce();
  });
});

describe('backup archive hardening', () => {
  it('rejects unsafe paths', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest())),
      '../evil.txt': strToU8('x')
    });
    await expect(inspectBackup(archive)).rejects.toThrow('unsafe archive path');
  });

  it('rejects an archive without a complete end-of-central-directory record', async () => {
    const backup = await exportBackup();
    const bytes = new Uint8Array(await backup.blob.arrayBuffer());
    const truncated = bytes.subarray(0, bytes.byteLength - 22);

    await expect(inspectBackup(asFile(new Blob([truncated])))).rejects.toThrow('not a zip');
  });

  it('rejects central-directory metadata that disagrees with local entries', async () => {
    const backup = await exportBackup();
    const bytes = new Uint8Array(await backup.blob.arrayBuffer());
    const central = centralEntryOffset(bytes, 'media/m1.jpg');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(central + 24, view.getUint32(central + 24, true) + 1, true);

    await expect(inspectBackup(asFile(new Blob([bytes])))).rejects.toThrow('not a zip');
  });

  it('rejects oversized entries and suspicious compression ratios', async () => {
    const oversized = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest())),
      'media/big.jpg': new Uint8Array(20 * 1024 * 1024 + 1)
    });
    await expect(inspectBackup(oversized)).rejects.toThrow('archive entry too large');

    const bomb = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest())),
      'media/bomb.jpg': new Uint8Array(9 * 1024 * 1024)
    });
    await expect(inspectBackup(bomb)).rejects.toThrow('suspicious compression ratio');

    const streamedBomb = descriptorZipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest())),
      'media/bomb.jpg': new Uint8Array(9 * 1024 * 1024)
    });
    await expect(inspectBackup(streamedBomb)).rejects.toThrow('suspicious compression ratio');
  });

  it('rejects manifest count and relationship mismatches', async () => {
    const mismatch = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        counts: { trips: 0 },
        trips: [{ id: 't1' }]
      })))
    });
    await expect(inspectBackup(mismatch)).rejects.toThrow('invalid manifest');

    const orphan = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        segments: [{ id: 's1', tripId: 'missing' }]
      })))
    });
    await expect(inspectBackup(orphan)).rejects.toThrow('invalid manifest');
  });

  it('rejects missing media and invalid coordinates', async () => {
    const manifest: any = validManifest({
      trips: [{ id: 't1' }],
      mediaMeta: [{ id: 'm1', tripId: 't1' }]
    });
    const { integrity, ...payload } = manifest;
    manifest.integrity = { algo: 'SHA-256', payload: await sha256Hex(stableStringify(payload)), files: {} };
    const missingMedia = manifestFile(manifest);
    await expect(inspectBackup(missingMedia)).rejects.toThrow('missing media');

    const badCoords = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        trips: [{ id: 't1' }],
        waypoints: [{ id: 'w1', tripId: 't1', lat: 91, lon: 0 }]
      })))
    });
    await expect(inspectBackup(badCoords)).rejects.toThrow('invalid manifest');
  });

  it('rejects snapshots with missing or mismatched segment ownership', async () => {
    const snapshot = {
      id: 'snap-1', tripId: 't1', segmentId: 'missing', segmentIndex: 0,
      seq: 0, createdAt: 1, points: []
    };
    const orphan = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 3, trips: [{ id: 't1' }], trackSnapshots: [snapshot]
      })))
    });
    await expect(inspectBackup(orphan)).rejects.toThrow('invalid manifest');

    const mismatched = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 3, trips: [{ id: 't1' }, { id: 't2' }],
        segments: [{ id: 's1', tripId: 't1', index: 0 }],
        trackSnapshots: [{ ...snapshot, segmentId: 's1', tripId: 't2' }]
      })))
    });
    await expect(inspectBackup(mismatched)).rejects.toThrow('invalid manifest');
  });

  it('rejects duplicate snapshot chunk sequences', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 3, trips: [{ id: 't1' }], segments: [{ id: 's1', tripId: 't1', index: 0 }],
        trackSnapshots: [
          { id: 'snap-1', tripId: 't1', segmentId: 's1', segmentIndex: 0, seq: 0, createdAt: 1, points: [] },
          { id: 'snap-2', tripId: 't1', segmentId: 's1', segmentIndex: 0, seq: 0, createdAt: 1, points: [] }
        ]
      })))
    });
    await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
  });

  it('requires an explicit snapshot collection in version 3 backups', async () => {
    for (const trackSnapshots of [undefined, null]) {
      const archive = zipFile({
        'manifest.json': strToU8(JSON.stringify(validManifest({
          version: 3, trips: [{ id: 't1' }], trackSnapshots
        })))
      });
      await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
    }
  });

  it('rejects missing snapshot sequence numbers', async () => {
    for (const seqs of [[1], [0, 2]]) {
      const archive = zipFile({
        'manifest.json': strToU8(JSON.stringify(validManifest({
          version: 3, trips: [{ id: 't1' }], segments: [{ id: 's1', tripId: 't1', index: 0 }],
          trackSnapshots: seqs.map((seq) => ({
            id: `snap-${seq}`, tripId: 't1', segmentId: 's1', segmentIndex: 0,
            seq, createdAt: 1, points: []
          }))
        })))
      });
      await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
    }
  });

  it('rejects inconsistent segment indexes within one snapshot', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 3, trips: [{ id: 't1' }], segments: [{ id: 's1', tripId: 't1', index: 0 }],
        trackSnapshots: [
          { id: 'snap-1', tripId: 't1', segmentId: 's1', segmentIndex: 0, seq: 0, createdAt: 1, points: [] },
          { id: 'snap-2', tripId: 't1', segmentId: 's1', segmentIndex: 1, seq: 1, createdAt: 1, points: [] }
        ]
      })))
    });
    await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
  });

  it('rejects active chunks with invalid, duplicate, or missing sequences', async () => {
    const cases = [
      [{ id: 'chunk-1', seq: -1 }],
      [{ id: 'chunk-1', seq: 0.5 }],
      [{ id: 'chunk-1', seq: Number.MAX_SAFE_INTEGER + 1 }],
      [{ id: 'chunk-1', seq: 0 }, { id: 'chunk-2', seq: 0 }],
      [{ id: 'chunk-1', seq: 1 }],
      [{ id: 'chunk-1', seq: 0 }, { id: 'chunk-2', seq: 2 }]
    ];
    for (const chunks of cases) {
      const archive = zipFile({
        'manifest.json': strToU8(JSON.stringify(validManifest({
          trips: [{ id: 't1' }], segments: [{ id: 's1', tripId: 't1', index: 0 }],
          trackChunks: chunks.map((chunk) => ({ ...chunk, tripId: 't1', segmentId: 's1', points: [] }))
        })))
      });
      await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
    }
  });

  it('rejects snapshot indexes that do not match the owning segment', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 3, trips: [{ id: 't1' }], segments: [{ id: 's1', tripId: 't1', index: 2 }],
        trackSnapshots: [{
          id: 'snap-1', tripId: 't1', segmentId: 's1', segmentIndex: 1,
          seq: 0, createdAt: 1, points: []
        }]
      })))
    });
    await expect(inspectBackup(archive)).rejects.toThrow('invalid manifest');
  });
});

describe('backup restore', () => {
  it('overwrites conflicts and removes their shared-link mappings in one transaction', async () => {
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    expect(inspected.conflicts).toEqual(['t1']);
    mock.db.__state().shareImports.set('fingerprint-1', {
      fingerprint: 'fingerprint-1', tripId: 't1', createdAt: 1
    });
    const transactionsBeforeRestore = mock.db.__txCalls();
    const restored = await restoreBackup(asFile(backup.blob), 'overwrite', inspected);
    expect(restored).toBe(1);
    expect(mock.db.__txCalls() - transactionsBeforeRestore).toBe(1);
    expect(mock.db.__transactionScopes().at(-1)).toContain(mock.db.shareImports);
    expect(mock.db.__state().trips.has('t1')).toBe(true);
    expect(mock.db.__state().media.has('m1')).toBe(true);
    expect(mock.db.__state().shareImports.has('fingerprint-1')).toBe(false);
  });

  it('rolls back deletions when a later write fails', async () => {
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    mock.db.__state().shareImports.set('fingerprint-1', {
      fingerprint: 'fingerprint-1', tripId: 't1', createdAt: 1
    });
    mock.db.__failNextPut('media');
    await expect(restoreBackup(asFile(backup.blob), 'overwrite', inspected)).rejects.toThrow('write failed');
    const trips = mock.db.__state().trips;
    expect(trips.get('t1')?.name).toBe('Test trip');
    expect(mock.db.__state().media.get('m1')?.tripId).toBe('t1');
    expect(mock.db.__state().shareImports.has('fingerprint-1')).toBe(true);
  });

  it('skips conflicts without deleting existing data', async () => {
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    const restored = await restoreBackup(asFile(backup.blob), 'skip', inspected);
    expect(restored).toBe(0);
    expect(mock.db.__state().trips.get('t1')?.name).toBe('Test trip');
  });

  it('rejects id collisions outside overwritten trips', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        version: 1,
        trips: [{ id: 't1' }, { id: 't2' }],
        segments: [{ id: 's1', tripId: 't2' }]
      })))
    });
    const inspected = await inspectBackup(archive);
    expect(inspected.conflicts).toEqual(['t1']);
    await expect(restoreBackup(archive, 'skip', inspected)).rejects.toThrow('archive id collision');
    expect(mock.db.__state().segments.get('s1')?.tripId).toBe('t1');
  });

  it('keeps a committed restore successful when cancellation arrives at the commit boundary', async () => {
    const archive = manifestFile(validManifest({ version: 1, trips: [{ id: 't2', name: 'Two' }] }));
    const inspected = await inspectBackup(archive);
    const controller = new AbortController();
    const transaction = mock.db.transaction;
    mock.db.transaction = async (...args) => {
      const result = await transaction(...args);
      controller.abort();
      return result;
    };
    try {
      await expect(restoreBackup(archive, 'skip', inspected, { signal: controller.signal })).resolves.toBe(1);
      expect(mock.db.__state().trips.get('t2')?.name).toBe('Two');
    } finally {
      mock.db.transaction = transaction;
    }
  });

  it('rolls back when cancellation is queued after the final progress callback but before commit', async () => {
    const archive = manifestFile(validManifest({ version: 1, trips: [{ id: 't2', name: 'Two' }] }));
    const inspected = await inspectBackup(archive);
    const controller = new AbortController();
    const onProgress = vi.fn(() => { queueMicrotask(() => controller.abort()); });

    await expect(restoreBackup(archive, 'skip', inspected, { signal: controller.signal, onProgress }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(mock.db.__state().trips.has('t2')).toBe(false);
  });

  it('rolls back the restore transaction when aborted', async () => {
    const archive = manifestFile(validManifest({
      version: 1,
      trips: [{ id: 't2', name: 'Two' }, { id: 't3', name: 'Three' }]
    }));
    const inspected = await inspectBackup(archive);
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());

    await expect(restoreBackup(archive, 'skip', inspected, { signal: controller.signal, onProgress }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.db.__state().trips.has('t2')).toBe(false);
    expect(mock.db.__state().trips.has('t3')).toBe(false);
  });
});
