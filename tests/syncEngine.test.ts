import { describe, expect, it } from 'vitest';
import { SyncSession, type SyncChannel, type SyncSummary } from '../src/core/syncEngine';
import type { SyncLedgerStore, SyncPeerRecord } from '../src/core/syncStore';
import type { SyncDataRepository } from '../src/core/repositories';
import type {
  SyncLedgerEntry, SyncPeerIdentity, SyncTable, SyncWireMessage
} from '../src/core/syncProtocol';
import { digestLedger, syncKey } from '../src/core/syncProtocol';

const TABLE_ORDER: SyncTable[] = ['trips', 'segments', 'media', 'trackChunks', 'waypoints'];

class MemoryData implements SyncDataRepository {
  tables = new Map<SyncTable, Map<string, any>>(TABLE_ORDER.map((table) => [table, new Map()]));
  async allTrips() { return [...this.tables.get('trips')!.values()]; }
  async countRows(table: SyncTable) { return this.tables.get(table)!.size; }
  async eachRow(table: SyncTable, callback: (row: any) => void | Promise<void>) {
    for (const row of [...this.tables.get(table)!.values()]) await callback(row);
  }
  async getRow(table: SyncTable, id: string) { return this.tables.get(table)!.get(id) ?? null; }
  async putRow(table: SyncTable, row: any) { this.tables.get(table)!.set(row.id, row); }
  async deleteRow(table: SyncTable, id: string) { this.tables.get(table)!.delete(id); }
}

class MemoryLedger implements SyncLedgerStore {
  entries = new Map<string, SyncLedgerEntry>();
  peers = new Map<string, SyncPeerRecord>();
  meta = new Map<string, any>();
  cursor = 1;
  async all() { return [...this.entries.values()]; }
  async get(key: string) { return this.entries.get(key); }
  async put(entry: SyncLedgerEntry) { this.entries.set(entry.key, entry); }
  async putMany(entries: SyncLedgerEntry[]) { for (const entry of entries) this.entries.set(entry.key, entry); }
  async allocateCursors(count: number) { const start = this.cursor; this.cursor += count; return start; }
  async getPeer(deviceId: string) { return this.peers.get(deviceId); }
  async putPeer(peer: SyncPeerRecord) { this.peers.set(peer.deviceId, peer); }
  async deletePeer(deviceId: string) { this.peers.delete(deviceId); }
  async listPeers() { return [...this.peers.values()]; }
  async getMeta(key: string) { return this.meta.get(key); }
  async setMeta(key: string, value: any) { this.meta.set(key, value); }
}

class Channel implements SyncChannel {
  peer!: Channel;
  handler: ((message: SyncWireMessage) => void) | null = null;
  closeHandler: ((reason?: string) => void) | null = null;
  pending: SyncWireMessage[] = [];
  sent: SyncWireMessage[] = [];
  closed = false;
  async send(message: SyncWireMessage) {
    if (this.closed) throw new Error('closed');
    this.sent.push(message);
    const copy = JSON.parse(JSON.stringify(message));
    await Promise.resolve();
    this.peer.deliver(copy);
  }
  deliver(message: SyncWireMessage) {
    if (this.handler) this.handler(message);
    else this.pending.push(message);
  }
  setMessageHandler(handler: (message: SyncWireMessage) => void) {
    this.handler = handler;
    const pending = this.pending.splice(0, this.pending.length);
    for (const message of pending) handler(message);
  }
  onClose(handler: (reason?: string) => void) { this.closeHandler = handler; }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.peer.closeHandler?.('closed');
  }
}

function pair() {
  const a = new Channel();
  const b = new Channel();
  a.peer = b;
  b.peer = a;
  return [a, b] as const;
}

const identityA = {
  deviceId: 'dev-aaaaaaaaaa', name: 'Phone A',
  publicJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) }
};
const identityB = {
  deviceId: 'dev-bbbbbbbbbb', name: 'Phone B',
  publicJwk: { kty: 'EC' as const, crv: 'P-256' as const, x: 'C'.repeat(43), y: 'D'.repeat(43) }
};
const peerA: SyncPeerIdentity = { ...identityA, fingerprint: 'AAAA BBBB CCCC' };
const peerB: SyncPeerIdentity = { ...identityB, fingerprint: 'DDDD EEEE FFFF' };

function trip(id = 'trip-1', name = 'Ridge walk', updatedAt = 100, status = 'finished') {
  return { id, name, status, activity: 'hike', createdAt: 10, updatedAt, schemaVersion: 1, privacy: {} };
}

async function addTrip(data: MemoryData, row: any) {
  await data.putRow('trips', row);
  await data.putRow('segments', { id: `seg-${row.id}`, tripId: row.id, index: 0, startTime: 1, endTime: 2 });
  await data.putRow('trackChunks', {
    id: `chunk-${row.id}`, tripId: row.id, segmentId: `seg-${row.id}`, seq: 0,
    points: [{ lat: 30, lon: 120, t: 1 }, { lat: 30.1, lon: 120.1, t: 2 }]
  });
  await data.putRow('waypoints', {
    id: `wp-${row.id}`, tripId: row.id, lat: 30, lon: 120, type: 'view', name: 'Lookout', time: 1
  });
}

function session(
  identity: typeof identityA,
  peer: SyncPeerIdentity,
  data: MemoryData,
  ledger: MemoryLedger,
  channel: Channel,
  signal?: AbortSignal
) {
  const store = new SyncSession({
    identity, peer, data, ledger, channel,
    direction: identity.deviceId === identityA.deviceId ? 'sent' : 'received',
    signal
  });
  const promise = store.start();
  return promise.finally(() => channel.close());
}

async function settle(promises: Promise<SyncSummary>[]) {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sync test timeout')), 5000));
  return Promise.race([Promise.all(promises), timeout]);
}

async function initialSync(dataA: MemoryData, dataB: MemoryData, ledgerA: MemoryLedger, ledgerB: MemoryLedger) {
  const [ca, cb] = pair();
  return settle([
    session(identityA, peerB, dataA, ledgerA, ca),
    session(identityB, peerA, dataB, ledgerB, cb)
  ]);
}

describe('sync engine', () => {
  it('copies a finished trip and core records to an empty device', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip());
    const [summaryA, summaryB] = await initialSync(dataA, dataB, ledgerA, ledgerB);
    expect(summaryA.sent).toBeGreaterThan(0);
    expect(summaryB.received).toBe(4);
    expect((await dataB.getRow('trips', 'trip-1')).name).toBe('Ridge walk');
    expect((await dataB.getRow('trackChunks', 'chunk-trip-1')).points).toHaveLength(2);
    expect((await dataB.getRow('waypoints', 'wp-trip-1')).name).toBe('Lookout');
    expect(await digestLedger(await ledgerA.all())).toBe(await digestLedger(await ledgerB.all()));
    expect(ledgerB.peers.get(identityA.deviceId)?.peerCursor).toBeGreaterThan(0);
    expect(summaryB.applied).toBe(4);
  });

  it('converges concurrent edits with the newer stamp and deterministic tie-break', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip('trip-1', 'Newer', 500));
    await addTrip(dataB, trip('trip-1', 'Older', 400));
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    expect((await dataA.getRow('trips', 'trip-1')).name).toBe('Newer');
    expect((await dataB.getRow('trips', 'trip-1')).name).toBe('Newer');
    expect(ledgerA.entries.get(syncKey('trips', 'trip-1'))?.hash)
      .toBe(ledgerB.entries.get(syncKey('trips', 'trip-1'))?.hash);
  });

  it('propagates deletions as tombstones and removes remote data', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip());
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    expect(await dataB.getRow('trips', 'trip-1')).toBeTruthy();
    await dataA.deleteRow('trips', 'trip-1');
    await dataA.deleteRow('segments', 'seg-trip-1');
    await dataA.deleteRow('trackChunks', 'chunk-trip-1');
    await dataA.deleteRow('waypoints', 'wp-trip-1');
    const [ca, cb] = pair();
    await settle([
      session(identityA, peerB, dataA, ledgerA, ca),
      session(identityB, peerA, dataB, ledgerB, cb)
    ]);
    expect(await dataB.getRow('trips', 'trip-1')).toBeNull();
    expect(await dataB.getRow('waypoints', 'wp-trip-1')).toBeNull();
    expect(ledgerA.entries.get(syncKey('trips', 'trip-1'))?.deleted).toBe(true);
    expect(ledgerB.entries.get(syncKey('trips', 'trip-1'))?.deleted).toBe(true);
  });

  it('excludes recording trips and their child records', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip('trip-rec', 'Active', 100, 'recording'));
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    expect(dataB.tables.get('trips')!.size).toBe(0);
    expect(ledgerA.entries.size).toBe(0);
  });

  it('streams media bytes and verifies their hashes', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip());
    const blob = new Blob([new Uint8Array(40_000).fill(7)], { type: 'image/jpeg' });
    const thumb = new Blob([new Uint8Array(300).fill(3)], { type: 'image/webp' });
    await dataA.putRow('media', {
      id: 'media-1', tripId: 'trip-1', blob, thumb, width: 100, height: 80, createdAt: 2
    });
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    const received = await dataB.getRow('media', 'media-1');
    expect(received.blob.size).toBe(40_000);
    expect(received.thumb.size).toBe(300);
    expect(new Uint8Array(await received.blob.arrayBuffer())[39_999]).toBe(7);
    expect(ledgerB.entries.get(syncKey('media', 'media-1'))?.blobHash)
      .toBe(ledgerA.entries.get(syncKey('media', 'media-1'))?.blobHash);
  });

  it('resumes incrementally after an interrupted transfer', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip());
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    // Second full reconciliation establishes cursors in both directions.
    await initialSync(dataA, dataB, ledgerA, ledgerB);
    await dataB.putRow('trips', { ...(await dataB.getRow('trips', 'trip-1')), name: 'Renamed', updatedAt: 700 });
    const [ca, cb] = pair();
    const summaries = await settle([
      session(identityA, peerB, dataA, ledgerA, ca),
      session(identityB, peerA, dataB, ledgerB, cb)
    ]);
    expect((await dataA.getRow('trips', 'trip-1')).name).toBe('Renamed');
    const bManifest = cb.sent.filter((message) => message.type === 'manifest') as any[];
    expect(bManifest.flatMap((message) => message.entries).length).toBeLessThan(5);
    expect(summaries[0].applied).toBe(1);
  });

  it('waits for the peer to persist before reporting completion and closing', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await addTrip(dataA, trip());
    let releasePeer!: () => void;
    let peerWriteStarted!: () => void;
    const peerGate = new Promise<void>((resolve) => { releasePeer = resolve; });
    const peerWriting = new Promise<void>((resolve) => { peerWriteStarted = resolve; });
    const putPeer = ledgerB.putPeer.bind(ledgerB);
    ledgerB.putPeer = async (peer) => {
      peerWriteStarted();
      await peerGate;
      await putPeer(peer);
    };
    const [ca, cb] = pair();
    let resolved = false;
    const first = session(identityA, peerB, dataA, ledgerA, ca).then((summary) => {
      resolved = true;
      return summary;
    });
    const second = session(identityB, peerA, dataB, ledgerB, cb);
    await peerWriting;
    expect(resolved).toBe(false);
    expect(ca.closed).toBe(false);
    expect(cb.closed).toBe(false);
    releasePeer();
    const [summaryA, summaryB] = await settle([first, second]);
    expect(summaryA.digest).toBe(summaryB.digest);
    expect(ledgerB.peers.get(identityA.deviceId)).toBeTruthy();
    expect(ca.sent.some((message) => message.type === 'complete' && message.ack)).toBe(true);
    expect(cb.sent.some((message) => message.type === 'complete' && message.ack)).toBe(true);
  });

  it('rejects a peer whose pinned identity changed', async () => {
    const dataA = new MemoryData();
    const dataB = new MemoryData();
    const ledgerA = new MemoryLedger();
    const ledgerB = new MemoryLedger();
    await ledgerA.putPeer({
      ...peerB, lastSyncAt: 1, peerCursor: 0, direction: 'received', records: 0, bytes: 0,
      publicJwk: { ...peerB.publicJwk, x: 'Z'.repeat(43) }
    });
    const [ca, cb] = pair();
    const controller = new AbortController();
    const first = session(identityA, peerB, dataA, ledgerA, ca).then(() => null, (error) => error);
    const second = session(identityB, peerA, dataB, ledgerB, cb, controller.signal).then(() => null, (error) => error);
    const errorA = await first;
    controller.abort();
    await second;
    expect(errorA?.code).toBe('sync-identity-changed');
  });
});
