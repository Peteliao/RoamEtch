import { expect, test, type Page } from '@playwright/test';
import { blockExternal } from './utils';

async function createHistoricalDatabase(page: Page, version: number, schemaVersion?: number) {
  await blockExternal(page);
  await page.route('**/src/main.ts', (route) => route.abort());
  await page.goto('/');
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
          id: 'waypoint-0', tripId: 'migration-trip', lat: 30, lon: 120, time: 1500, mediaIds: []
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
  await page.unroute('**/src/main.ts');
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
      return {
        version: Math.floor(database.version / 10),
        nativeVersion: database.version,
        stores: [...database.objectStoreNames].sort(),
        name: trip?.name,
        schemaVersion: trip?.schemaVersion ?? null
      };
    } finally {
      database.close();
    }
  });
}

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
    expect(restored.version).toBe(3);
    expect(restored.target).toBe(3);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.points).toEqual([2, 1]);
    expect(restored.waypoints).toBe(1);
    expect(restored.shares).toBe(version >= 2 ? 1 : 0);
    expect(restored.snapshots?.points ?? 0).toBe(version === 3 ? 2 : 0);
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
  expect(await readRawDatabase(page)).toMatchObject({ version: 3, name: '历史迁移回归', schemaVersion: 1 });
  const points = await page.evaluate(async () => {
    const full = await (window as any).__lt.store.loadTripFull('migration-trip');
    return full.segments.flatMap((segment) => segment.points).length;
  });
  expect(points).toBe(3);
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
  expect(await readRawDatabase(page)).toMatchObject({ version: 3, name: '历史迁移回归', schemaVersion: 1 });
});
