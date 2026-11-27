// Device-local sync state. This lives in a separate IndexedDB so pairings,
// cursors and tombstones never leak into backups or the trip schema.
import Dexie from 'dexie';
import { createDeviceIdentity, fingerprintForPublicJwk, type SyncDeviceIdentity } from './syncIdentity';
import { sanitizePeerName, type SyncLedgerEntry, type SyncPeerIdentity, type SyncTable } from './syncProtocol';

export const SYNC_DATABASE_NAME = 'roametch-sync';
export const SYNC_DATABASE_VERSION = 1;

export interface SyncPeerRecord extends SyncPeerIdentity {
  lastSyncAt: number;
  peerCursor: number;
  direction: 'sent' | 'received';
  records: number;
  bytes: number;
}

export interface SyncLedgerStore {
  all(): Promise<SyncLedgerEntry[]>;
  get(key: string): Promise<SyncLedgerEntry | undefined>;
  put(entry: SyncLedgerEntry): Promise<void>;
  putMany(entries: SyncLedgerEntry[]): Promise<void>;
  allocateCursors(count: number): Promise<number>;
  getPeer(deviceId: string): Promise<SyncPeerRecord | undefined>;
  putPeer(peer: SyncPeerRecord): Promise<void>;
  deletePeer(deviceId: string): Promise<void>;
  listPeers(): Promise<SyncPeerRecord[]>;
  getMeta(key: string): Promise<any>;
  setMeta(key: string, value: any): Promise<void>;
}

class SyncStateDatabase extends Dexie {
  identity: any;
  ledger: any;
  peers: any;
  meta: any;

  constructor() {
    super(SYNC_DATABASE_NAME);
    this.version(SYNC_DATABASE_VERSION).stores({
      identity: 'id',
      ledger: '&key, table, cursor, deleted, tripId',
      peers: '&deviceId, lastSyncAt',
      meta: 'key'
    });
    this.on?.('versionchange', () => this.close());
  }
}

let stateDb: SyncStateDatabase | null = null;

function db() {
  if (!stateDb) stateDb = new SyncStateDatabase();
  return stateDb;
}

class DexieSyncLedgerStore implements SyncLedgerStore {
  all() {
    return db().ledger.toArray() as Promise<SyncLedgerEntry[]>;
  }
  get(key: string) {
    return db().ledger.get(key) as Promise<SyncLedgerEntry | undefined>;
  }
  async put(entry: SyncLedgerEntry) {
    await db().ledger.put(entry);
  }
  async putMany(entries: SyncLedgerEntry[]) {
    if (entries.length) await db().ledger.bulkPut(entries);
  }
  async allocateCursors(count: number) {
    const amount = Math.max(1, Math.floor(Number(count) || 1));
    return db().transaction('rw', db().meta, async () => {
      const row = await db().meta.get('nextCursor');
      const start = Math.max(1, Number(row?.value) || 1);
      await db().meta.put({ key: 'nextCursor', value: start + amount });
      return start;
    });
  }
  getPeer(deviceId: string) {
    return db().peers.get(deviceId) as Promise<SyncPeerRecord | undefined>;
  }
  async putPeer(peer: SyncPeerRecord) {
    await db().peers.put(peer);
  }
  async deletePeer(deviceId: string) {
    await db().peers.delete(deviceId);
  }
  listPeers() {
    return db().peers.orderBy('lastSyncAt').reverse().toArray() as Promise<SyncPeerRecord[]>;
  }
  async getMeta(key: string) {
    return (await db().meta.get(key))?.value;
  }
  async setMeta(key: string, value: any) {
    await db().meta.put({ key, value });
  }
}

let store: DexieSyncLedgerStore | null = null;
export function syncLedgerStore(): SyncLedgerStore {
  if (!store) store = new DexieSyncLedgerStore();
  return store;
}

let identityPromise: Promise<SyncDeviceIdentity> | null = null;

export async function loadOrCreateSyncIdentity(displayName = '') {
  if (!identityPromise) {
    identityPromise = (async () => {
      const existing = await db().identity.get('self');
      if (existing?.privateJwk && existing?.publicJwk) {
        return {
          deviceId: existing.deviceId,
          name: sanitizePeerName(existing.name),
          publicJwk: existing.publicJwk,
          privateJwk: existing.privateJwk,
          createdAt: existing.createdAt || Date.now()
        } as SyncDeviceIdentity;
      }
      const identity = await createDeviceIdentity(displayName || '');
      await db().identity.put({ id: 'self', ...identity });
      return identity;
    })().catch((error) => {
      identityPromise = null;
      throw error;
    });
  }
  return identityPromise;
}

export async function saveSyncIdentityName(identity: SyncDeviceIdentity, name: string) {
  const clean = sanitizePeerName(name);
  const updated = { ...identity, name: clean };
  await db().identity.put({ id: 'self', ...updated });
  identityPromise = Promise.resolve(updated);
  return updated;
}

export async function syncIdentityFingerprint(identity: SyncDeviceIdentity) {
  return fingerprintForPublicJwk(identity.publicJwk);
}

export async function removeSyncPeer(deviceId: string) {
  await syncLedgerStore().deletePeer(deviceId);
}

/** Wipes pairing identities, cursors and tombstones. Trip data is untouched. */
export async function eraseSyncState() {
  identityPromise = null;
  store = null;
  if (stateDb) {
    stateDb.close();
    stateDb = null;
  }
  try { await Dexie.delete(SYNC_DATABASE_NAME); } catch { /* no database yet */ }
}

export async function syncStateSummary() {
  const ledger = await syncLedgerStore().all();
  const peers = await syncLedgerStore().listPeers();
  return {
    records: ledger.filter((entry) => !entry.deleted).length,
    tombstones: ledger.filter((entry) => entry.deleted).length,
    tables: ledger.reduce((counts, entry) => {
      counts[entry.table] = (counts[entry.table] || 0) + 1;
      return counts;
    }, {} as Partial<Record<SyncTable, number>>),
    peers
  };
}
