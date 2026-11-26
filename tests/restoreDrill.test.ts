import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tableNames = ['trips', 'segments', 'trackChunks', 'trackSnapshots', 'waypoints', 'media', 'elevCache', 'shareImports'] as const;
  const instances = new Map<string, any>();
  const failOpen = new Set<any>();
  const blockedDeletes = new Map<any, Array<() => void>>();
  let failPut: any = null;
  let configureDatabase: ((name: string, database: any) => void) | null = null;
  const emit = vi.fn();

  const keyOf = (name: string, row: any) => name === 'elevCache' ? row.key : name === 'shareImports' ? row.fingerprint : row.id;

  function createDatabase(name: string) {
    const state: Record<string, Map<string, any>> = Object.fromEntries(tableNames.map((table) => [table, new Map()]));
    const listeners = new Map<string, Set<Function>>();
    const db: any = {
      name, state, listeners, operations: [], schemas: [], upgrades: [],
      opened: false, closed: false, deleted: false, closeCalls: 0, blockedEvents: 0
    };
    for (const table of tableNames) {
      db[table] = {
        toArray: vi.fn(async () => [...state[table].values()]),
        get: vi.fn(async (id) => state[table].get(id)),
        bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => state[table].get(id))),
        put: vi.fn(async (row: any) => {
          db.operations.push({ kind: 'put', table, row });
          if (failPut?.database === db && failPut.table === table && (!failPut.match || failPut.match(row))) {
            failPut = null;
            throw new Error('injected write failure');
          }
          state[table].set(keyOf(table, row), row);
        }),
        add: vi.fn(async (row: any) => {
          if (state[table].has(keyOf(table, row))) throw new Error('ConstraintError');
          state[table].set(keyOf(table, row), row);
        }),
        delete: vi.fn(async (id: string) => { state[table].delete(id); }),
        where: (field: string) => ({
          equals: (value: any) => ({
            delete: vi.fn(async () => {
              db.operations.push({ kind: 'delete-where', table, field, value });
              for (const [key, row] of [...state[table]]) if (row[field] === value) state[table].delete(key);
            }),
            toArray: vi.fn(async () => [...state[table].values()].filter((row) => row[field] === value))
          })
        })
      };
    }
    db.version = vi.fn((number: number) => {
      db.schemas.push(number);
      const version: any = {
        stores: (schema: any) => { version.schema = schema; return version; },
        upgrade: (upgrade: Function) => { db.upgrades.push(upgrade); return version; }
      };
      return version;
    });
    db.on = vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)?.delete(handler);
    });
    db.open = vi.fn(async () => {
      if (failOpen.has(db)) throw new Error('injected open failure');
      db.opened = true;
      return db;
    });
    db.close = vi.fn(() => {
      db.closed = true;
      db.closeCalls++;
    });
    db.delete = vi.fn(async () => {
      db.close({ disableAutoOpen: true });
      for (const handler of [...(listeners.get('versionchange') || [])]) handler({ newVersion: null });
      const waiters = blockedDeletes.get(db);
      if (waiters) {
        db.blockedEvents++;
        for (const handler of [...(listeners.get('blocked') || [])]) handler({ newVersion: null });
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      db.deleted = true;
    });
    db.transaction = vi.fn(async (...args: any[]) => {
      const write = args[args.length - 1];
      const snapshot = new Map(tableNames.map((table) => [table, new Map(state[table])]));
      const transaction: any = { active: true, abort: vi.fn(() => { transaction.active = false; }) };
      try {
        return await write(transaction);
      } catch (error) {
        for (const table of tableNames) state[table] = snapshot.get(table)!;
        throw error;
      }
    });
    instances.set(name, db);
    return db;
  }

  const mainDb = createDatabase('localtrace');
  mainDb.state.trips.set('restore-drill-trip', { id: 'restore-drill-trip', name: 'Main database trip', schemaVersion: 1 });

  const reset = () => {
    instances.clear();
    instances.set('localtrace', mainDb);
    failOpen.clear();
    blockedDeletes.clear();
    failPut = null;
    configureDatabase = null;
    vi.clearAllMocks();
    for (const table of tableNames) mainDb.state[table] = new Map();
    mainDb.state.trips.set('restore-drill-trip', { id: 'restore-drill-trip', name: 'Main database trip', schemaVersion: 1 });
    mainDb.operations.length = 0;
    mainDb.opened = false;
    mainDb.closed = false;
    mainDb.deleted = false;
    mainDb.closeCalls = 0;
  };

  return {
    createDatabase, mainDb, reset, instances, failOpen, blockedDeletes, emit,
    setDatabaseConfigure: (configure: (name: string, database: any) => void) => { configureDatabase = configure; },
    configure: (name: string, database: any) => configureDatabase?.(name, database),
    failNextPut: (database: any, table: string, match?: (row: any) => boolean) => { failPut = { database, table, match }; },
    releaseBlocked: (database: any) => {
      const waiters = blockedDeletes.get(database);
      blockedDeletes.delete(database);
      for (const resolve of waiters || []) resolve();
    },
    releaseAllBlocked: () => {
      for (const [database, waiters] of blockedDeletes) {
        blockedDeletes.delete(database);
        for (const resolve of waiters) resolve();
      }
    },
    byRole: (role: 'source' | 'target') => [...instances.values()].find((database) => database.name.endsWith(`-${role}`)),
    mainSnapshot: () => JSON.stringify(Object.fromEntries(tableNames.map((table) => [table, [...mainDb.state[table].values()]])))
  };
});

vi.mock('../src/core/store', () => ({
  db: mocks.mainDb,
  TRIP_SCHEMA_VERSION: 1,
  abortTransactionOnSignal: (transaction: any, signal?: AbortSignal) => {
    if (!signal) return () => {};
    const abort = () => { if (transaction.active) transaction.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  }
}));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));
vi.mock('dexie', () => ({
  default: class MockDexie {
    constructor(name: string) {
      const database = mocks.createDatabase(name);
      mocks.configure(name, database);
      return database;
    }
  }
}));

const { runRestoreDrill } = await import('../src/core/restoreDrill');
const { sha256Hex } = await import('../src/core/integrity');

const ORIGINAL_BYTES = mediaBytes(257, 0x4a);
const THUMB_BYTES = mediaBytes(73, 0x54);
const ORIGINAL_SHA256 = 'b5c31125b09193313382a52ed8d98a8d03bc1cc86d09ed9729bee2e527d66569';
const THUMB_SHA256 = '17327d56c77665829f7d7ccff521a7f336c4a96c8d896ed0626b2754ed3ddbda';
const EXPECTED_COUNTS = { trips: 1, segments: 1, trackChunks: 1, trackSnapshots: 1, waypoints: 1, media: 1 };
const ALL_CHECKS = {
  manifest: true, integrity: true, rows: true, coordinates: true, timestamps: true,
  media: true, skip: true, overwrite: true, corruptionRejected: true, atomicRollback: true
};

function mediaBytes(length: number, seed: number) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 255;
  bytes[0] = 0xff; bytes[1] = 0xd8; bytes[2] = 0xff;
  bytes[length - 2] = 0xff; bytes[length - 1] = 0xd9;
  return bytes;
}

async function bytesOf(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

beforeEach(() => {
  mocks.reset();
  vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: vi.fn() });
});

afterEach(() => {
  mocks.releaseAllBlocked();
  vi.unstubAllGlobals();
});

describe('isolated restore drill', () => {
  it('runs the production v3 ZIP pipeline in two temporary databases without touching the main database', async () => {
    const mainBefore = mocks.mainSnapshot();
    const result = await runRestoreDrill();

    expect(result).toMatchObject({
      ok: true, supported: true, status: 'ok', counts: EXPECTED_COUNTS, mediaChecked: 2,
      checks: ALL_CHECKS, cleanup: { closed: true, deleted: true, blocked: false, databases: 2 }, error: null
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(mocks.instances.size).toBe(3);
    for (const role of ['source', 'target'] as const) {
      const database = mocks.byRole(role)!;
      expect(database.name).toMatch(/^localtrace-restore-drill-.*-(source|target)$/);
      expect(database.name).not.toBe('localtrace');
      expect(database.schemas).toEqual([1, 2, 3]);
      expect(database.closed).toBe(true);
      expect(database.deleted).toBe(true);
    }
    expect(mocks.mainSnapshot()).toBe(mainBefore);
    expect(mocks.mainDb.transaction).not.toHaveBeenCalled();
    expect(mocks.mainDb.operations).toEqual([]);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('verifies exact original and thumbnail bytes against known SHA-256 digests', async () => {
    const result = await runRestoreDrill();
    const media = mocks.byRole('target')!.state.media.get('restore-drill-media');
    const original = await bytesOf(media.blob);
    const thumb = await bytesOf(media.thumb);

    expect(result.checks.media).toBe(true);
    expect(result.mediaChecked).toBe(2);
    expect([...original]).toEqual([...ORIGINAL_BYTES]);
    expect([...thumb]).toEqual([...THUMB_BYTES]);
    expect(await sha256Hex(original)).toBe(ORIGINAL_SHA256);
    expect(await sha256Hex(thumb)).toBe(THUMB_SHA256);
  });

  it('exercises skip and overwrite conflicts through inspect and restore', async () => {
    const result = await runRestoreDrill();
    const target = mocks.byRole('target')!;
    const tripWrites = target.operations
      .filter((operation: any) => operation.kind === 'put' && operation.table === 'trips')
      .map((operation: any) => operation.row.name);

    expect(result.checks.skip).toBe(true);
    expect(result.checks.overwrite).toBe(true);
    expect(tripWrites).toEqual(['Restore drill fixture', 'Restore drill conflict sentinel', 'Restore drill fixture']);
    expect(target.state.trips.get('restore-drill-trip').name).toBe('Restore drill fixture');
    expect(target.state.shareImports.size).toBe(0);
  });

  it('rejects corrupt media before a write transaction and leaves the verified target unchanged', async () => {
    const result = await runRestoreDrill();
    const target = mocks.byRole('target')!;
    const writeTransactions = target.transaction.mock.calls.filter((call: any[]) => call[0] === 'rw');

    expect(result.ok).toBe(true);
    expect(result.checks.corruptionRejected).toBe(true);
    expect(result.checks.atomicRollback).toBe(true);
    expect(writeTransactions).toHaveLength(4);
    expect(target.state.trips.get('restore-drill-trip').name).toBe('Restore drill fixture');
    expect(target.state.trackChunks.get('restore-drill-chunk').points).toHaveLength(2);
    expect(target.state.trackSnapshots.get('restore-drill-snapshot').points).toHaveLength(2);
    expect(target.state.waypoints.get('restore-drill-waypoint').time).toBe(1_700_000_015_000);
  });

  it('aborts during restore, rolls back partial writes and still deletes both temporary databases', async () => {
    const controller = new AbortController();
    const mainBefore = mocks.mainSnapshot();
    const result = await runRestoreDrill({
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === 'restore' && progress.loaded === 1) controller.abort();
      }
    });
    const target = mocks.byRole('target')!;

    expect(result).toMatchObject({
      ok: false, supported: true, status: 'aborted', counts: emptyCounts(),
      cleanup: { closed: true, deleted: true, blocked: false, databases: 2 },
      error: { code: 'restore-drill-aborted' }
    });
    for (const table of Object.values(target.state) as Map<string, any>[]) expect(table.size).toBe(0);
    expect(mocks.byRole('source')!.deleted).toBe(true);
    expect(mocks.mainSnapshot()).toBe(mainBefore);
  });

  it('cleans up after a restore write failure and leaves no partial target rows', async () => {
    const mainBefore = mocks.mainSnapshot();
    mocks.setDatabaseConfigure((name, database) => {
      if (name.endsWith('-target')) mocks.failNextPut(database, 'media');
    });
    const result = await runRestoreDrill();
    const target = mocks.byRole('target')!;

    expect(result).toMatchObject({
      ok: false, status: 'failed', counts: emptyCounts(), mediaChecked: 0,
      cleanup: { closed: true, deleted: true, blocked: false, databases: 2 },
      error: { code: 'restore-drill-restore-failed' }
    });
    for (const table of Object.values(target.state) as Map<string, any>[]) expect(table.size).toBe(0);
    expect(mocks.byRole('source')!.deleted).toBe(true);
    expect(mocks.mainSnapshot()).toBe(mainBefore);
  });

  it('handles blocked deletion and closes on versionchange before reporting success', async () => {
    let target: any;
    mocks.setDatabaseConfigure((name, database) => {
      if (name.endsWith('-target')) {
        target = database;
        mocks.blockedDeletes.set(database, []);
      }
    });
    const running = runRestoreDrill();
    await vi.waitFor(() => expect(target?.blockedEvents).toBe(1));
    mocks.releaseBlocked(target);
    const result = await running;

    expect(result.ok).toBe(true);
    expect(result.cleanup).toMatchObject({ closed: true, deleted: true, blocked: true, databases: 2 });
    expect(target.closeCalls).toBeGreaterThanOrEqual(2);
  });

  it('does not claim success when temporary database deletion remains blocked', async () => {
    let target: any;
    mocks.setDatabaseConfigure((name, database) => {
      if (name.endsWith('-target')) {
        target = database;
        mocks.blockedDeletes.set(database, []);
      }
    });
    const result = await runRestoreDrill({ cleanupTimeoutMs: 20 });

    expect(result).toMatchObject({
      ok: false, status: 'failed', counts: EXPECTED_COUNTS, mediaChecked: 2,
      cleanup: { closed: true, deleted: false, blocked: true, databases: 2 },
      error: { code: 'restore-drill-cleanup-failed' }
    });
    mocks.releaseBlocked(target);
    await vi.waitFor(() => expect(target.deleted).toBe(true));
  });

  it('cleans up an opened source when opening the restore target fails', async () => {
    const mainBefore = mocks.mainSnapshot();
    mocks.setDatabaseConfigure((name, database) => {
      if (name.endsWith('-target')) mocks.failOpen.add(database);
    });
    const result = await runRestoreDrill();

    expect(result).toMatchObject({
      ok: false, status: 'failed', counts: emptyCounts(),
      cleanup: { closed: true, deleted: true, blocked: false, databases: 2 },
      error: { code: 'restore-drill-open-failed' }
    });
    expect(mocks.byRole('source')!.deleted).toBe(true);
    expect(mocks.byRole('target')!.deleted).toBe(true);
    expect(mocks.mainSnapshot()).toBe(mainBefore);
  });

  it('returns aborted without creating temporary databases for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runRestoreDrill({ signal: controller.signal });

    expect(result).toMatchObject({
      ok: false, status: 'aborted', counts: emptyCounts(),
      cleanup: { closed: true, deleted: true, blocked: false, databases: 0 },
      error: { code: 'restore-drill-aborted' }
    });
    expect(mocks.instances.size).toBe(1);
  });

  it('returns an explicit unsupported result without creating databases when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const result = await runRestoreDrill();

    expect(result).toMatchObject({
      ok: false, supported: false, status: 'unsupported', counts: emptyCounts(), mediaChecked: 0,
      cleanup: { closed: true, deleted: true, blocked: false, databases: 0 },
      error: { code: 'restore-drill-unsupported' }
    });
    expect(mocks.instances.size).toBe(1);
  });
});

function emptyCounts() {
  return { trips: 0, segments: 0, trackChunks: 0, trackSnapshots: 0, waypoints: 0, media: 0 };
}
