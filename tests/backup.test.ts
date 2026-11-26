import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
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
  const reset = () => {
    state = Object.fromEntries(names.map((n) => [n, new Map(initial[n].map((r) => [r.id, r]))]));
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
    transactionModes.push(args[0]);
    transactionScopes.push(args[1]);
    activeTransactions++;
    try {
      return await fn();
    } catch (e) {
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

vi.mock('../src/core/store', () => ({ db: mock.db, TRIP_SCHEMA_VERSION: 1 }));
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

  it('adds the current trip schema version when restoring legacy records', async () => {
    const legacy = zipFile({
      'manifest.json': strToU8(JSON.stringify(validManifest({ version: 2, trips: [{ id: 'legacy-1', name: 'Legacy' }] })))
    });
    const inspected = await inspectBackup(legacy);
    await restoreBackup(legacy, 'skip', inspected);
    expect(mock.db.__state().trips.get('legacy-1')?.schemaVersion).toBe(1);
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
});
