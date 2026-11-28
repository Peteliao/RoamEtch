import { expect, test, type Page } from '@playwright/test';
import { blockExternal } from './utils';

test.use({ serviceWorkers: 'block' });

async function createHistoricalDatabase(page: Page, version: number, schemaVersion?: number) {
  await blockExternal(page);
  await page.route('**/src/main.ts*', (route) => route.abort());
  await page.goto('/');
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('localtrace');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('database deletion blocked'));
    });
  });
  await page.evaluate(async ({ version, schemaVersion }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('localtrace', version * 10);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('trips', { keyPath: 'id' });
        database.createObjectStore('segments', { keyPath: 'id' });
        database.createObjectStore('trackChunks', { keyPath: 'id' });
        database.createObjectStore('waypoints', { keyPath: 'id' });
        database.createObjectStore('media', { keyPath: 'id' });
        database.createObjectStore('elevCache', { keyPath: 'key' });
        if (version >= 2) database.createObjectStore('shareImports', { keyPath: 'fingerprint' });
        if (version >= 3) database.createObjectStore('trackSnapshots', { keyPath: 'id' });

        const tx = request.transaction!;
        tx.objectStore('trips').put({
          id: 'migration-trip', name: '历史迁移回归', activity: 'hike', status: 'finished',
          createdAt: 1000, updatedAt: 3000,
          ...(schemaVersion == null ? {} : { schemaVersion })
        });
        tx.objectStore('segments').put({ id: 'segment-0', tripId: 'migration-trip', index: 0, startTime: 1000, endTime: 2000 });
        tx.objectStore('segments').put({ id: 'segment-1', tripId: 'migration-trip', index: 1, startTime: 2500, endTime: 3000 });
        tx.objectStore('trackChunks').put({
          id: 'chunk-0', tripId: 'migration-trip', segmentId: 'segment-0', seq: 0,
          points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
        });
        tx.objectStore('trackChunks').put({
          id: 'chunk-1', tripId: 'migration-trip', segmentId: 'segment-1', seq: 0,
          points: [{ lat: 30.02, lon: 120.02, t: 3000 }]
        });
        tx.objectStore('waypoints').put({
          id: 'waypoint-0', tripId: 'migration-trip', lat: 30, lon: 120, time: 1500, mediaIds: ['media-0']
        });
        tx.objectStore('media').put({
          id: 'media-0', tripId: 'migration-trip', width: 1, height: 1,
          blob: new Blob(['historical-media'], { type: 'image/jpeg' })
        });
        tx.objectStore('elevCache').put({ key: '30.000,120.000', elevation: 100, fetchedAt: 1 });
        if (version >= 2) tx.objectStore('shareImports').put({ fingerprint: 'legacy-share', tripId: 'migration-trip', createdAt: 1 });
        if (version >= 3) tx.objectStore('trackSnapshots').put({
          id: 'snapshot-0', tripId: 'migration-trip', segmentId: 'segment-0', segmentIndex: 0,
          seq: 0, createdAt: 4000,
          points: [{ lat: 30, lon: 120, t: 1000 }, { lat: 30.01, lon: 120.01, t: 2000 }]
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
  }, { version, schemaVersion });
  await page.unroute('**/src/main.ts*');
}

async function readRawDatabase(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('localtrace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const trip = await new Promise<any>((resolve, reject) => {
        const request = database.transaction('trips', 'readonly').objectStore('trips').get('migration-trip');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const media = await new Promise<any>((resolve, reject) => {
        const request = database.transaction('media', 'readonly').objectStore('media').get('media-0');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {
        version: Math.floor(database.version / 10),
        nativeVersion: database.version,
        stores: [...database.objectStoreNames].sort(),
        name: trip?.name,
        schemaVersion: trip?.schemaVersion ?? null,
        mediaText: media?.blob ? await media.blob.text() : null
      };
    } finally {
      database.close();
    }
  });
}

async function readCheckpointSummary(page: Page) {
  return page.evaluate(async () => {
    const databases = (await indexedDB.databases()).filter((entry) =>
      entry.name?.startsWith('localtrace:migration-checkpoint:')
    );
    if (databases.length === 0) return { count: 0, sourceVersion: null, fromVersion: null, trips: null, media: null };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databases[databases.length - 1].name!);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const metadata = await new Promise<any>((resolve, reject) => {
        const request = database.transaction('__migration_checkpoint__', 'readonly')
          .objectStore('__migration_checkpoint__').get(database.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return {
        count: databases.length,
        sourceVersion: metadata.sourceVersion,
        fromVersion: metadata.fromVersion,
        trips: metadata.counts.trips,
        media: metadata.counts.media
      };
    } finally {
      database.close();
    }
  });
}

test('initializes a new install through a verified empty checkpoint', async ({ page }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  expect(await page.evaluate(() => (window as any).__lt.store.db.verno)).toBe(4);
  expect(await readRawDatabase(page)).toMatchObject({ version: 4, nativeVersion: 40 });
  expect(await readCheckpointSummary(page)).toMatchObject({ count: 1, sourceVersion: 0, fromVersion: 0 });
});

test('coordinates ordinary writes with an exclusive cross-tab database lock', async ({ page, context }) => {
  await blockExternal(page);
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  const other = await context.newPage();
  await blockExternal(other);
  await other.goto('/');
  await expect.poll(() => other.evaluate(() => Boolean((window as any).__lt))).toBe(true);

  await page.evaluate(() => {
    const state = window as any;
    state.__exclusiveStarted = new Promise<void>((resolve) => {
      state.__exclusiveTask = navigator.locks.request('localtrace-database-write', { mode: 'exclusive' }, async () => {
        resolve();
        await new Promise<void>((release) => { state.__releaseExclusive = release; });
      });
    });
  });
  await page.evaluate(() => (window as any).__exclusiveStarted);

  await other.evaluate(() => {
    const state = window as any;
    state.__crossTabWriteDone = false;
    state.__crossTabWrite = state.__lt.store.createTrip({ name: '跨标签页锁测试' })
      .then(() => { state.__crossTabWriteDone = true; });
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await other.evaluate(() => (window as any).__crossTabWriteDone)).toBe(false);
  expect(await other.evaluate(async () => (await (window as any).__lt.store.listTrips()).length)).toBe(0);

  await page.evaluate(() => (window as any).__releaseExclusive());
  await other.evaluate(() => (window as any).__crossTabWrite);
  expect(await other.evaluate(async () => (await (window as any).__lt.store.listTrips()).map((trip: any) => trip.name))).toEqual(['跨标签页锁测试']);
  await other.close();
});

for (const version of [1, 2, 3]) {
  test(`upgrades a real version ${version} IndexedDB without losing trip data`, async ({ page }) => {
    const pageErrors: string[] = [];
    await createHistoricalDatabase(page, version, version === 3 ? 1 : undefined);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
    const restored = await page.evaluate(async () => {
      const { store, migration } = (window as any).__lt;
      const full = await store.loadTripFull('migration-trip');
      return {
        version: store.db.verno,
        target: migration.DATABASE_SCHEMA_VERSION,
        schemaVersion: full.trip.schemaVersion,
        points: full.segments.map((segment) => segment.points.length),
        waypoints: full.waypoints.length,
        shares: await store.db.shareImports.count(),
        snapshots: await store.getTrackSnapshotSummary('migration-trip')
      };
    });
    expect(restored.version).toBe(4);
    expect(restored.target).toBe(4);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.points).toEqual([2, 1]);
    expect(restored.waypoints).toBe(1);
    expect(restored.shares).toBe(version >= 2 ? 1 : 0);
    expect(restored.snapshots?.points ?? 0).toBe(version === 3 ? 2 : 0);
    expect(await readRawDatabase(page)).toMatchObject({
      version: 4, nativeVersion: 40, name: '历史迁移回归', mediaText: 'historical-media'
    });
    expect(await readCheckpointSummary(page)).toMatchObject({
      count: 1, sourceVersion: version * 10, fromVersion: version, trips: 1, media: 1
    });
    expect(pageErrors).toEqual([]);
  });
}

test('blocks a future trip schema and recovers after the source version is repaired', async ({ page }) => {
  await createHistoricalDatabase(page, 2, 99);
  await page.reload();
  await expect(page.locator('#boot-sub')).toContainText('更新版本');
  expect(await readRawDatabase(page)).toMatchObject({ version: 2, name: '历史迁移回归', schemaVersion: 99 });
  expect((await readRawDatabase(page)).stores).not.toContain('trackSnapshots');

  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('localtrace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('trips', 'readwrite');
        const store = tx.objectStore('trips');
        const request = store.get('migration-trip');
        request.onsuccess = () => store.put({ ...request.result, schemaVersion: 1 });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      database.close();
    }
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  expect(await readRawDatabase(page)).toMatchObject({ version: 4, nativeVersion: 40, name: '历史迁移回归', schemaVersion: 1 });
  const points = await page.evaluate(async () => {
    const full = await (window as any).__lt.store.loadTripFull('migration-trip');
    return full.segments.flatMap((segment) => segment.points).length;
  });
  expect(points).toBe(3);
  expect(await readCheckpointSummary(page)).toMatchObject({ count: 1, sourceVersion: 20, fromVersion: 2 });
});

test('rolls a failed post-open verification back to the verified migration checkpoint', async ({ page }) => {
  await createHistoricalDatabase(page, 2, 1);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const call = 'databaseCheckpointCore.openDatabaseWithMigrationRecovery(storeCore.db, preflight)';
  await page.route('**/src/main.ts', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    expect(body).toContain(call);
    await route.fulfill({
      response,
      body: body.replace(call, `databaseCheckpointCore.openDatabaseWithMigrationRecovery(storeCore.db, preflight, {
        verify: async (database, currentPreflight) => {
          if (!sessionStorage.getItem('__ltRollbackInjected')) {
            sessionStorage.setItem('__ltRollbackInjected', '1');
            await new Promise((resolve, reject) => {
              const raw = database.backendDB();
              const tx = raw.transaction('trips', 'readwrite');
              const store = tx.objectStore('trips');
              const read = store.get('migration-trip');
              read.onsuccess = () => store.put({ ...read.result, name: '注入验证失败' });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
              tx.onabort = () => reject(tx.error);
            });
            throw new Error('Injected post-open verification failure');
          }
          return migrationCore.verifyDatabaseMigration(database, currentPreflight);
        }
      })`)
    });
  });

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  expect(await readRawDatabase(page)).toMatchObject({
    version: 4, nativeVersion: 40, name: '历史迁移回归', schemaVersion: 1, mediaText: 'historical-media'
  });
  expect(await readCheckpointSummary(page)).toMatchObject({ count: 1, sourceVersion: 20, fromVersion: 2, trips: 1, media: 1 });
  const recoveryDatabases = await page.evaluate(async () =>
    (await indexedDB.databases()).filter((entry) => entry.name?.includes(':migration-recovery:'))
  );
  expect(recoveryDatabases).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('blocks a future trip schema in an otherwise current database', async ({ page }) => {
  await createHistoricalDatabase(page, 3, 99);
  await page.reload();
  await expect(page.locator('#boot-sub')).toContainText('更新版本');
  expect(await readRawDatabase(page)).toMatchObject({ version: 3, nativeVersion: 30, name: '历史迁移回归', schemaVersion: 99 });
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(false);
});

test('aborts the upgrade when preflight is unavailable and a trip schema is unsupported', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(indexedDB, 'databases', { configurable: true, value: undefined });
  });
  await createHistoricalDatabase(page, 2, 99);
  await page.reload();
  await expect(page.locator('#boot-sub')).toContainText(/future-trip-schema-version|更新版本|Boot failed/);
  expect(await readRawDatabase(page)).toMatchObject({ version: 2, name: '历史迁移回归', schemaVersion: 99 });
  expect((await readRawDatabase(page)).stores).not.toContain('trackSnapshots');
});

test('a failed upgrade transaction preserves the previous schema and all rows', async ({ page }) => {
  await createHistoricalDatabase(page, 2, 1);
  const failure = await page.evaluate(async () => {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('localtrace', 30);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const tx = request.transaction!;
          const snapshotStore = request.result.createObjectStore('trackSnapshots', { keyPath: 'id' });
          snapshotStore.put({ id: 'partial', tripId: 'migration-trip' });
          const trips = tx.objectStore('trips');
          const read = trips.get('migration-trip');
          read.onsuccess = () => {
            const write = trips.put({ ...read.result, name: '未完成的升级' });
            write.onsuccess = () => {
              tx.abort();
              reject(new Error('forced migration failure'));
            };
          };
        };
        request.onsuccess = () => { request.result.close(); resolve(); };
      });
      return null;
    } catch (error) {
      return String(error?.message || error);
    }
  });
  expect(failure).toContain('forced migration failure');
  expect(await readRawDatabase(page)).toMatchObject({ version: 2, name: '历史迁移回归', schemaVersion: 1 });
  expect((await readRawDatabase(page)).stores).not.toContain('trackSnapshots');

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__lt))).toBe(true);
  expect(await readRawDatabase(page)).toMatchObject({ version: 4, nativeVersion: 40, name: '历史迁移回归', schemaVersion: 1 });
  expect(await readCheckpointSummary(page)).toMatchObject({ count: 1, sourceVersion: 20, fromVersion: 2 });
});
