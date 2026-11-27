// Dexie-backed row access for the sync engine. The engine only sees a cursor
// over opaque table rows; storage details stay behind this boundary.
import * as store from './store';
import type { SyncTable } from './syncProtocol';

export interface SyncDataRepository {
  allTrips(): Promise<any[]>;
  countRows(table: SyncTable): Promise<number>;
  eachRow(table: SyncTable, callback: (row: any) => void | Promise<void>): Promise<void>;
  getRow(table: SyncTable, id: string): Promise<any>;
  putRow(table: SyncTable, row: any): Promise<void>;
  deleteRow(table: SyncTable, id: string): Promise<void>;
}

export class DexieSyncDataRepository implements SyncDataRepository {
  async allTrips() {
    return store.db.trips.toArray();
  }

  countRows(table: SyncTable) {
    return store.db.table(table).count();
  }

  async eachRow(table: SyncTable, callback: (row: any) => void | Promise<void>) {
    const source = store.db.table(table);
    const pageSize = table === 'media' ? 40 : 300;
    let offset = 0;
    for (;;) {
      const rows = await source.offset(offset).limit(pageSize).toArray();
      if (!rows.length) return;
      for (const row of rows) await callback(row);
      offset += rows.length;
    }
  }

  getRow(table: SyncTable, id: string) {
    return store.db.table(table).get(id);
  }

  async putRow(table: SyncTable, row: any) {
    await store.db.table(table).put(row);
  }

  async deleteRow(table: SyncTable, id: string) {
    await store.db.table(table).delete(id);
  }
}

export const syncDataRepository = new DexieSyncDataRepository();
