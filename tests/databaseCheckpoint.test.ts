import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATABASE_MIGRATIONS, DATABASE_SCHEMA_VERSION, DatabaseMigrationError,
  logicalDatabaseVersion, preflightDatabase, verifyDatabaseMigration
} from '../src/core/migrations';

const mocks = vi.hoisted(() => ({ diag: vi.fn() }));
vi.mock('../src/core/diag', () => ({ diag: mocks.diag }));

import {
  createMigrationCheckpoint, openDatabaseWithMigrationRecovery,
  readMigrationCheckpoint, readMigrationRecoveryState, type MigrationCheckpoint
} from '../src/core/databaseCheckpoint';

const SOURCE_NAME = 'checkpoint-test-source';
const TRIP_ID = 'historical-trip';
const MEDIA_BYTES = [0, 255, 1, 2, 3, 128];
const openConnections = new Set<IDBDatabase>();
let mainDatabase: any;

function checkpointPrefix() {
  return `${SOURCE_NAME}:migration-checkpoint:`;
}

function recoveryPrefix() {
  return `${SOURCE_NAME}:migration-recovery:`;
}

function currentDexie(name = SOURCE_NAME) {
  const database = new Dexie(name) as any;
  for (const migration of DATABASE_MIGRATIONS) {
    const version = database.version(migration.version).stores(migration.stores);
    if (migration.upgrade) version.upgrade(migration.upgrade);
  }
  database.on('versionchange', () => database.close());
  return database;
}

function track<T extends IDBDatabase>(database: T): T {
  openConnections.add(database);
  return database;
}

function openRaw(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(track(request.result));
    request.onerror = () => reject(request.error);
  });
}

function requestRows(database: IDBDatabase, storeName: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function nativeSchema(database: IDBDatabase) {
  return [...database.objectStoreNames].sort().map((name) => {
    const store = database.transaction(name, 'readonly').objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].sort().map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      })
    };
  });
}

async function databaseNames(prefix: string) {
  return (await indexedDB.databases()).map((entry) => entry.name).filter((name) => name?.startsWith(prefix)).sort();
}

async function createHistoricalSource(version: number) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(SOURCE_NAME, version * 10);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('trips', { keyPath: 'id' });
      database.createObjectStore('segments', { keyPath: 'id' });
      database.createObjectStore('trackChunks', { keyPath: 'id' });
      database.createObjectStore('waypoints', { keyPath: 'id' });
      database.createObjectStore('media', { keyPath: 'id' });
      database.createObjectStore('elevCache', { keyPath: 'key' });
      if (version < 4) {
        database.createObjectStore('legacyNotes', { keyPath: 'id' });
        database.createObjectStore('legacyEvents', { autoIncrement: true });
        database.createObjectStore('legacyExternal');
      }
      if (version >= 2) database.createObjectStore('shareImports', { keyPath: 'fingerprint' });
      if (version >= 3) database.createObjectStore('trackSnapshots', { keyPath: 'id' });
      if (version >= 4) database.createObjectStore('quarantine', { keyPath: 'id' });
      const tx = request.transaction!;
      tx.objectStore('trips').createIndex('updatedAt', 'updatedAt');
      tx.objectStore('trips').createIndex('status', 'status');
      tx.objectStore('segments').createIndex('tripId', 'tripId');
      tx.objectStore('segments').createIndex('[tripId+index]', ['tripId', 'index']);
      tx.objectStore('trackChunks').createIndex('tripId', 'tripId');
      tx.objectStore('trackChunks').createIndex('segmentId', 'segmentId');
      tx.objectStore('trackChunks').createIndex('[segmentId+seq]', ['segmentId', 'seq']);
      tx.objectStore('waypoints').createIndex('tripId', 'tripId');
      tx.objectStore('waypoints').createIndex('time', 'time');
      tx.objectStore('media').createIndex('tripId', 'tripId');
      tx.objectStore('elevCache').createIndex('fetchedAt', 'fetchedAt');
      if (version >= 2) {
        tx.objectStore('shareImports').createIndex('tripId', 'tripId');
        tx.objectStore('shareImports').createIndex('createdAt', 'createdAt');
      }
      if (version >= 3) {
        const snapshots = tx.objectStore('trackSnapshots');
        snapshots.createIndex('tripId', 'tripId');
        snapshots.createIndex('segmentId', 'segmentId');
        snapshots.createIndex('[tripId+segmentId]', ['tripId', 'segmentId']);
        snapshots.createIndex('[segmentId+seq]', ['segmentId', 'seq']);
      }
      if (version >= 4) {
        const quarantine = tx.objectStore('quarantine');
        quarantine.createIndex('batchId', 'batchId');
        quarantine.createIndex('createdAt', 'createdAt');
        quarantine.createIndex('sourceTable', 'sourceTable');
        quarantine.createIndex('rowId', 'rowId');
        quarantine.createIndex('tripId', 'tripId');
      }

      tx.objectStore('trips').put({
        id: TRIP_ID, name: '历史数据', activity: 'hike', status: 'finished',
        createdAt: 1000, updatedAt: 3000,
        ...(version >= 3 ? { schemaVersion: 1 } : {})
      });
      tx.objectStore('segments').put({ id: 'segment-0', tripId: TRIP_ID, index: 0, startTime: 1000, endTime: 2000 });
      tx.objectStore('trackChunks').put({
        id: 'chunk-0', tripId: TRIP_ID, segmentId: 'segment-0', seq: 0,
        points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
      });
      tx.objectStore('waypoints').put({
        id: 'waypoint-0', tripId: TRIP_ID, lat: 30, lon: 120, time: 1500, mediaIds: ['media-0']
      });
      tx.objectStore('media').put({
        id: 'media-0', tripId: TRIP_ID, width: 1, height: 1,
        blob: new Blob([new Uint8Array(MEDIA_BYTES)], { type: 'image/jpeg' })
      });
      tx.objectStore('elevCache').put({ key: '30.000,120.000', elevation: 100, fetchedAt: 1 });
      if (version < 4) {
        tx.objectStore('legacyNotes').put({ id: 'note-0', text: 'unknown source stores are recovery data too' });
        tx.objectStore('legacyEvents').add({ event: 'first' });
        tx.objectStore('legacyEvents').add({ event: 'second' });
        tx.objectStore('legacyExternal').put({ event: 'external-first' }, 'external-a');
        tx.objectStore('legacyExternal').put({ event: 'external-second' }, 'external-b');
      }
      if (version >= 2) tx.objectStore('shareImports').put({ fingerprint: 'legacy-share', tripId: TRIP_ID, createdAt: 1 });
      if (version >= 3) tx.objectStore('trackSnapshots').put({
        id: 'snapshot-0', tripId: TRIP_ID, segmentId: 'segment-0', segmentIndex: 0,
        seq: 0, createdAt: 4000,
        points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
      });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
  });
}

async function expectMediaBytes(database: IDBDatabase, storeName = 'media') {
  const media = (await requestRows(database, storeName))[0];
  expect(media.blob).toBeInstanceOf(Blob);
  expect([...new Uint8Array(await media.blob.arrayBuffer())]).toEqual(MEDIA_BYTES);
}

beforeEach(() => {
  mocks.diag.mockClear();
  mainDatabase = undefined;
});

afterEach(async () => {
  mainDatabase?.close({ disableAutoOpen: true });
  for (const database of openConnections) database.close();
  openConnections.clear();
  const entries = await indexedDB.databases();
  for (const entry of entries) {
    if (entry.name) await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(entry.name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }
  vi.restoreAllMocks();
});

describe('migration recovery checkpoints', () => {
  it('copies every source store and Blob, verifies a deterministic fingerprint, and keeps only the latest checkpoint', async () => {
    await createHistoricalSource(1);
    const sourceBefore = await openRaw(SOURCE_NAME);
    expect(sourceBefore.version).toBe(10);
    sourceBefore.close();
    openConnections.delete(sourceBefore);

    const preflight = await preflightDatabase(SOURCE_NAME);
    const first = await createMigrationCheckpoint(preflight, { sourceName: SOURCE_NAME });
    expect(first).toMatchObject({
      sourceName: SOURCE_NAME, sourceVersion: 10, fromVersion: 1,
      counts: { trips: 1, media: 1, legacyNotes: 1, legacyEvents: 2, legacyExternal: 2 }
    });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.stores.map((store) => store.name)).toEqual(expect.arrayContaining([
      'media', 'legacyNotes', 'legacyEvents', 'legacyExternal'
    ]));

    const checkpoint = await openRaw(first.databaseName);
    await expectMediaBytes(checkpoint, '__migration_rows__:media');
    expect(await requestRows(checkpoint, '__migration_rows__:legacyEvents')).toEqual([
      { event: 'first' }, { event: 'second' }
    ]);
    expect(await requestRows(checkpoint, '__migration_rows__:legacyExternal')).toEqual([
      { event: 'external-first' }, { event: 'external-second' }
    ]);
    checkpoint.close();
    openConnections.delete(checkpoint);

    const second = await createMigrationCheckpoint(preflight, { sourceName: SOURCE_NAME });
    expect(second.databaseName).not.toBe(first.databaseName);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.counts).toEqual(first.counts);
    expect(await databaseNames(checkpointPrefix())).toEqual([second.databaseName]);
    expect(await readMigrationCheckpoint(second.databaseName, { sourceName: SOURCE_NAME })).toMatchObject({
      fingerprint: second.fingerprint
    });

    const sourceAfter = await openRaw(SOURCE_NAME);
    expect(sourceAfter.version).toBe(10);
    expect(sourceAfter.objectStoreNames.contains('shareImports')).toBe(false);
    sourceAfter.close();
    openConnections.delete(sourceAfter);
    expect(mocks.diag).toHaveBeenCalledWith('store', 'database migration checkpoint verified', expect.objectContaining({
      checkpoint: second.databaseName, fingerprint: second.fingerprint
    }));
  });

  it('detects checkpoint row and Blob mismatches before they can be used for recovery', async () => {
    await createHistoricalSource(2);
    const preflight = await preflightDatabase(SOURCE_NAME);
    const checkpoint = await createMigrationCheckpoint(preflight, { sourceName: SOURCE_NAME });
    const raw = await openRaw(checkpoint.databaseName);
    await new Promise<void>((resolve, reject) => {
      const tx = raw.transaction('__migration_rows__:media', 'readwrite');
      const store = tx.objectStore('__migration_rows__:media');
      const read = store.get('media-0');
      read.onsuccess = () => store.put({
        ...read.result,
        blob: new Blob(['tampered'], { type: 'image/jpeg' })
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    raw.close();
    openConnections.delete(raw);

    await expect(readMigrationCheckpoint(checkpoint.databaseName, { sourceName: SOURCE_NAME })).rejects.toMatchObject({
      name: 'DatabaseMigrationError', code: 'migration-checkpoint-verification-failed'
    });
    const source = await openRaw(SOURCE_NAME);
    expect(source.version).toBe(20);
    await expectMediaBytes(source);
  });

  it('surfaces quota as migration-checkpoint-capacity and never opens the source for upgrade', async () => {
    await createHistoricalSource(2);
    const preflight = await preflightDatabase(SOURCE_NAME);
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (value: any, key?: IDBValidKey) {
      if (this.name.startsWith('__migration_rows__:')) {
        throw new DOMException('Injected storage quota', 'QuotaExceededError');
      }
      return originalPut.call(this, value, key);
    });
    mainDatabase = currentDexie();
    const open = vi.spyOn(mainDatabase, 'open');

    await expect(openDatabaseWithMigrationRecovery(mainDatabase, preflight)).rejects.toMatchObject({
      name: 'DatabaseMigrationError',
      code: 'migration-checkpoint-capacity',
      message: expect.stringMatching(/Free storage.*database was not upgraded/)
    });
    expect(open).not.toHaveBeenCalled();
    const source = await openRaw(SOURCE_NAME);
    expect(source.version).toBe(20);
    expect(source.objectStoreNames.contains('trackSnapshots')).toBe(false);
    await expectMediaBytes(source);
  });

  it.each([1, 2, 3])('restores an injected post-migration verification failure from a v%s checkpoint into v4', async (version) => {
    await createHistoricalSource(version);
    const preflight = await preflightDatabase(SOURCE_NAME);
    mainDatabase = currentDexie();
    let injected = false;
    const result = await openDatabaseWithMigrationRecovery(mainDatabase, preflight, {
      blockedTimeoutMs: 100,
      deleteTimeoutMs: 100,
      verify: async (database, currentPreflight) => {
        if (!injected) {
          injected = true;
          await database.trips.update(TRIP_ID, { name: '损坏的升级结果' });
          throw new DatabaseMigrationError('migration-verification-failed', 'Injected post-open verification failure');
        }
        return verifyDatabaseMigration(database, currentPreflight);
      }
    });

    expect(result.rolledBack).toBe(true);
    expect(result.checkpoint?.fromVersion).toBe(version);
    expect(result.migration).toMatchObject({ fromVersion: version, toVersion: DATABASE_SCHEMA_VERSION, verified: true });
    expect(mainDatabase.isOpen()).toBe(true);
    expect(mainDatabase.verno).toBe(4);
    const restored = await openRaw(SOURCE_NAME);
    expect(logicalDatabaseVersion(restored.version)).toBe(4);
    const trip = (await requestRows(restored, 'trips'))[0];
    expect(trip).toMatchObject({ id: TRIP_ID, name: '历史数据', schemaVersion: 1 });
    expect((await requestRows(restored, 'trackChunks'))[0].points).toHaveLength(2);
    expect(await requestRows(restored, 'legacyNotes')).toEqual([
      { id: 'note-0', text: 'unknown source stores are recovery data too' }
    ]);
    expect((await requestRows(restored, 'legacyEvents')).map((row) => row.event)).toEqual(['first', 'second']);
    expect((await requestRows(restored, 'legacyExternal')).map((row) => row.event)).toEqual([
      'external-first', 'external-second'
    ]);
    expect(restored.transaction('legacyExternal').objectStore('legacyExternal').keyPath).toBeNull();
    expect(await requestRows(restored, 'shareImports')).toHaveLength(version >= 2 ? 1 : 0);
    expect(await requestRows(restored, 'trackSnapshots')).toHaveLength(version >= 3 ? 1 : 0);
    expect(restored.objectStoreNames.contains('quarantine')).toBe(true);
    await expectMediaBytes(restored);
    await expect(verifyDatabaseMigration(mainDatabase, preflight)).resolves.toMatchObject({ verified: true });
    expect(await databaseNames(checkpointPrefix())).toEqual([result.checkpoint!.databaseName]);
    expect(await databaseNames(recoveryPrefix())).toEqual([]);
    expect(mocks.diag).toHaveBeenCalledWith('store', 'database migration rollback verified', expect.objectContaining({
      checkpoint: result.checkpoint!.databaseName, verified: true
    }));
  });

  it('bounds a blocked main-database delete and retains both the checkpoint and verified temporary recovery DB', async () => {
    await createHistoricalSource(2);
    const preflight = await preflightDatabase(SOURCE_NAME);
    mainDatabase = currentDexie();
    let blocker: IDBDatabase | undefined;
    let injected = false;
    const started = Date.now();
    await expect(openDatabaseWithMigrationRecovery(mainDatabase, preflight, {
      deleteTimeoutMs: 50,
      verify: async (database, currentPreflight) => {
        if (!injected) {
          injected = true;
          blocker = await openRaw(SOURCE_NAME);
          blocker.onversionchange = () => { /* deliberately keep the failed DB open */ };
          await database.trips.update(TRIP_ID, { name: 'failed main' });
          throw new DatabaseMigrationError('migration-verification-failed', 'Injected verification failure');
        }
        return verifyDatabaseMigration(database, currentPreflight);
      }
    })).rejects.toMatchObject({
      name: 'DatabaseMigrationError', code: 'migration-rollback-blocked',
      message: expect.stringMatching(/retained/)
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    const rollbackLog = mocks.diag.mock.calls.find((call) => call[1] === 'database migration rollback started');
    const checkpointLog = mocks.diag.mock.calls.find((call) => call[1] === 'database migration checkpoint verified');
    const recoveryName = rollbackLog?.[2]?.recovery as string;
    const checkpointName = checkpointLog?.[2]?.checkpoint as string;
    expect(recoveryName).toEqual(expect.any(String));
    expect(checkpointName).toEqual(expect.any(String));
    const recovered = await openRaw(recoveryName);
    expect(recovered.version).toBe(40);
    expect((await requestRows(recovered, 'trips'))[0]).toMatchObject({ name: '历史数据', schemaVersion: 1 });
    await expectMediaBytes(recovered);
    await expect(readMigrationCheckpoint(checkpointName, { sourceName: SOURCE_NAME })).resolves.toMatchObject({
      databaseName: checkpointName
    });
    blocker?.close();
    // Let fake-indexeddb finish the already-pending blocked deletion before cleanup issues another one.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('resumes a rollback interrupted after the failed main database was deleted', async () => {
    await createHistoricalSource(2);
    const preflight = await preflightDatabase(SOURCE_NAME);
    mainDatabase = currentDexie();
    let failVerification = true;
    let migrationFailed = false;
    let failMainCopy = true;
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: any, key?: IDBValidKey) {
      if (failMainCopy && migrationFailed && this.transaction.db.name === SOURCE_NAME) {
        failMainCopy = false;
        throw new Error('Simulated process interruption while restoring the main database');
      }
      return originalPut.call(this, value, key);
    });
    await expect(openDatabaseWithMigrationRecovery(mainDatabase, preflight, {
      deleteTimeoutMs: 100,
      verify: async (database, currentPreflight) => {
        if (failVerification) {
          failVerification = false;
          await database.trips.update(TRIP_ID, { name: 'failed main' });
          migrationFailed = true;
          throw new DatabaseMigrationError('migration-verification-failed', 'Injected verification failure');
        }
        return verifyDatabaseMigration(database, currentPreflight);
      }
    })).rejects.toMatchObject({ name: 'DatabaseMigrationError', code: 'migration-rollback-failed' });
    expect(await readMigrationRecoveryState(SOURCE_NAME)).toMatchObject({
      sourceName: SOURCE_NAME, fromVersion: 2, toVersion: DATABASE_SCHEMA_VERSION, phase: 'restoring'
    });
    putSpy.mockRestore();
    mainDatabase.close({ disableAutoOpen: true });

    const restartPreflight = await preflightDatabase(SOURCE_NAME);
    const result = await openDatabaseWithMigrationRecovery(mainDatabase, restartPreflight, { deleteTimeoutMs: 100 });
    expect(result.rolledBack).toBe(true);
    expect(result.checkpoint?.fromVersion).toBe(2);
    expect(await readMigrationRecoveryState(SOURCE_NAME)).toBeUndefined();
    const restored = await openRaw(SOURCE_NAME);
    expect((await requestRows(restored, 'trips'))[0]).toMatchObject({ name: '历史数据', schemaVersion: 1 });
    expect((await requestRows(restored, 'trackChunks'))[0].points).toHaveLength(2);
    await expectMediaBytes(restored);
    expect(await databaseNames(recoveryPrefix())).toEqual([]);
  });

  it('treats an absent rollback journal as empty when database enumeration is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(indexedDB, 'databases');
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
    try {
      await expect(readMigrationRecoveryState(SOURCE_NAME, { blockedTimeoutMs: 100 })).resolves.toBeUndefined();
    } finally {
      if (descriptor) Object.defineProperty(indexedDB, 'databases', descriptor);
      else delete (indexedDB as any).databases;
    }
  });

  it('does not hide an unsupported rollback journal when database enumeration is unavailable', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(`${SOURCE_NAME}:migration-recovery-journal`, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('migration_recovery');
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const descriptor = Object.getOwnPropertyDescriptor(indexedDB, 'databases');
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
    try {
      await expect(readMigrationRecoveryState(SOURCE_NAME, { blockedTimeoutMs: 100 })).rejects.toMatchObject({
        code: 'migration-rollback-journal-invalid'
      });
    } finally {
      if (descriptor) Object.defineProperty(indexedDB, 'databases', descriptor);
      else delete (indexedDB as any).databases;
    }
  });

  it('initializes an absent source through a verified empty checkpoint without creating it early', async () => {
    const preflight = await preflightDatabase(SOURCE_NAME);
    expect(preflight).toMatchObject({ fromVersion: 0, needsUpgrade: true, skipped: false, stores: [] });
    mainDatabase = currentDexie();
    const result = await openDatabaseWithMigrationRecovery(mainDatabase, preflight);
    expect(result).toMatchObject({
      rolledBack: false,
      checkpoint: { sourceVersion: 0, fromVersion: 0, counts: {} },
      migration: { fromVersion: 0, toVersion: DATABASE_SCHEMA_VERSION, verified: true }
    });
    expect(mainDatabase.isOpen()).toBe(true);
    expect(mainDatabase.verno).toBe(DATABASE_SCHEMA_VERSION);
    expect(await databaseNames(checkpointPrefix())).toEqual([result.checkpoint!.databaseName]);
    await expect(readMigrationCheckpoint(result.checkpoint!.databaseName, { sourceName: SOURCE_NAME })).resolves.toMatchObject({
      sourceVersion: 0, counts: {}
    });
  });

  it('opens the exact native v4 fixture without Dexie schema warnings or a checkpoint', async () => {
    await createHistoricalSource(4);
    const preflight = await preflightDatabase(SOURCE_NAME);
    expect(preflight).toMatchObject({ fromVersion: 4, needsUpgrade: false, skipped: false });
    mainDatabase = currentDexie();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await openDatabaseWithMigrationRecovery(mainDatabase, preflight);
    expect(result).toMatchObject({ rolledBack: false, checkpoint: undefined, migration: { verified: true, needsUpgrade: false } });
    expect(await databaseNames(checkpointPrefix())).toEqual([]);
    expect(mainDatabase.isOpen()).toBe(true);
    expect(mainDatabase.verno).toBe(4);
    const fixture = await openRaw(SOURCE_NAME);
    const current = mainDatabase.backendDB() as IDBDatabase;
    expect(fixture.version).toBe(40);
    expect(current.version).toBe(40);
    expect(nativeSchema(fixture)).toEqual(nativeSchema(current));
    fixture.close();
    openConnections.delete(fixture);
    expect(warn).not.toHaveBeenCalled();
  });
});
