import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sha256Hex, stableStringify } from '../src/core/integrity';

const mock = vi.hoisted(() => {
  const names = ['trips', 'segments', 'trackChunks', 'waypoints', 'media', 'elevCache'];
  const initial = {
    trips: [{ id: 't1', name: 'Test trip' }],
    segments: [{ id: 's1', tripId: 't1', index: 0, points: [] }],
    trackChunks: [],
    waypoints: [],
    media: [{ id: 'm1', tripId: 't1', blob: new Blob([new Uint8Array([1, 2, 3])]) }],
    elevCache: []
  };
  let state;
  let failPut = null;
  let txCalls = 0;
  const db: any = {};
  const reset = () => {
    state = Object.fromEntries(names.map((n) => [n, new Map(initial[n].map((r) => [r.id, r]))]));
    failPut = null;
    txCalls = 0;
  };
  reset();
  for (const name of names) {
    db[name] = {
      toArray: async () => [...state[name].values()],
      bulkGet: async (ids) => ids.map((id) => state[name].get(id)),
      put: async (row) => {
        if (failPut && failPut.table === name && failPut.match(row)) {
          failPut = null;
          throw new Error('write failed');
        }
        state[name].set(row.id, row);
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
    txCalls++;
    try {
      return await fn();
    } catch (e) {
      for (const n of names) state[n] = snapshot.get(n);
      throw e;
    }
  };
  db.__reset = reset;
  db.__state = () => state;
  db.__txCalls = () => txCalls;
  db.__failNextPut = (table, match = () => true) => { failPut = { table, match }; };
  return { db };
});

vi.mock('../src/core/store', () => ({ db: mock.db }));
vi.mock('../src/core/events', () => ({ emit: vi.fn() }));

const { exportBackup, inspectBackup, restoreBackup } = await import('../src/core/backup');

function asFile(blob) {
  return { size: blob.size, arrayBuffer: () => blob.arrayBuffer() };
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
    expect(inspected.manifest.version).toBe(2);
    expect(inspected.integrity.ok).toBe(true);
    expect(inspected.integrity.checked).toBe(1);
    expect(inspected.manifest.counts.media).toBe(1);
  });

  it('wraps an encrypted backup and requires the password to inspect it', async () => {
    const backup = await exportBackup({ password: 'correct horse battery' });
    expect(backup.encrypted).toBe(true);
    expect(backup.filename).toMatch(/^roametch-backup-\d{8}\.roametch\.enc$/);
    const bytes = new Uint8Array(await backup.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe('TRKMBKP1');
    await expect(inspectBackup(asFile(backup.blob))).rejects.toMatchObject({ code: 'backup-password-required' });
    await expect(inspectBackup(asFile(backup.blob), 'wrong password')).rejects.toMatchObject({ code: 'backup-decrypt-failed' });
    const inspected = await inspectBackup(asFile(backup.blob), 'correct horse battery');
    expect(inspected.encrypted).toBe(true);
    expect(inspected.integrity.ok).toBe(true);
    expect(inspected.manifest.trips[0].name).toBe('Test trip');
    const restored = await restoreBackup(asFile(backup.blob), 'overwrite', inspected);
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
});

describe('backup archive hardening', () => {
  it('rejects unsafe paths', async () => {
    const archive = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest())),
      '../evil.txt': strToU8('x')
    });
    await expect(inspectBackup(archive)).rejects.toThrow('unsafe archive path');
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
    const missingMedia = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        trips: [{ id: 't1' }],
        mediaMeta: [{ id: 'm1', tripId: 't1' }]
      })))
    });
    await expect(inspectBackup(missingMedia)).rejects.toThrow('missing media');

    const badCoords = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({
        trips: [{ id: 't1' }],
        waypoints: [{ id: 'w1', tripId: 't1', lat: 91, lon: 0 }]
      })))
    });
    await expect(inspectBackup(badCoords)).rejects.toThrow('invalid manifest');
  });
});

describe('backup restore', () => {
  it('overwrites conflicts in one transaction', async () => {
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    expect(inspected.conflicts).toEqual(['t1']);
    const restored = await restoreBackup(asFile(backup.blob), 'overwrite', inspected);
    expect(restored).toBe(1);
    expect(mock.db.__txCalls()).toBe(1);
    expect(mock.db.__state().trips.has('t1')).toBe(true);
    expect(mock.db.__state().media.has('m1')).toBe(true);
  });

  it('rolls back deletions when a later write fails', async () => {
    const backup = await exportBackup();
    const inspected = await inspectBackup(asFile(backup.blob));
    mock.db.__failNextPut('media');
    await expect(restoreBackup(asFile(backup.blob), 'overwrite', inspected)).rejects.toThrow('write failed');
    const trips = mock.db.__state().trips;
    expect(trips.get('t1')?.name).toBe('Test trip');
    expect(mock.db.__state().media.get('m1')?.tripId).toBe('t1');
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
});
