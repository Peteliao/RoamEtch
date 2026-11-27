// Bidirectional incremental sync over an authenticated peer channel.
// The engine only sees the SyncDataRepository and SyncLedgerStore contracts.
import {
  SYNC_MAX_ENTRIES, SYNC_MAX_MEDIA_BYTES, SYNC_MAX_WANT_KEYS, SYNC_MEDIA_CHUNK_BYTES,
  SYNC_PROTOCOL_VERSION, baseRecordStamp, blobDigest, compareSyncVersions, digestLedger, finiteStamp, nextLocalStamp,
  pageManifest, remoteWins, syncKey, syncRecordData, syncRecordHash, validateRemoteRow,
  verifyWireRecordHash, type SyncLedgerEntry, type SyncManifestEntry, type SyncPeerIdentity,
  type SyncRecordPayload, type SyncTable, type SyncWireMessage
} from './syncProtocol';
import { b64urlDecode, b64urlEncode } from './syncIdentity';
import type { SyncPeerRecord } from './syncStore';
import type { SyncLedgerStore } from './syncStore';
import type { SyncDataRepository } from './syncDataRepository';

export interface SyncChannel {
  send(message: SyncWireMessage): Promise<void> | void;
  setMessageHandler(handler: (message: SyncWireMessage) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

export type SyncPhase = 'preparing' | 'manifest' | 'transfer' | 'verifying' | 'done';

export interface SyncProgress {
  phase: SyncPhase;
  peerName: string;
  applied: number;
  total: number;
  sent: number;
  received: number;
  bytes: number;
  detail?: string;
}

export interface SyncSummary {
  peer: SyncPeerIdentity;
  applied: number;
  deleted: number;
  sent: number;
  received: number;
  bytes: number;
  digest: string;
  direction: 'sent' | 'received';
}

interface EngineOptions {
  identity: SyncDeviceIdentityLike;
  peer: SyncPeerIdentity;
  channel: SyncChannel;
  ledger: SyncLedgerStore;
  data: SyncDataRepository;
  direction: 'sent' | 'received';
  onProgress?: (progress: SyncProgress) => void;
  signal?: AbortSignal;
}

interface SyncDeviceIdentityLike {
  deviceId: string;
  name: string;
  publicJwk: SyncPeerIdentity['publicJwk'];
}

const TABLE_ORDER: Record<SyncTable, number> = {
  trips: 0, segments: 1, media: 2, trackChunks: 3, waypoints: 4
};

interface IncomingMedia {
  entry: SyncManifestEntry;
  payload: SyncRecordPayload;
  blobSize: number;
  thumbSize: number;
  blobType: string;
  thumbType: string;
  chunks: Map<string, Uint8Array>;
  received: number;
  bytes: number;
}

function syncError(code: string) {
  const error: any = new Error(code);
  error.code = code;
  return error;
}

function abortError() {
  try { return new DOMException('Aborted', 'AbortError'); }
  catch { return Object.assign(new Error('Aborted'), { name: 'AbortError' }); }
}

export class SyncSession {
  private options: EngineOptions;
  private local = new Map<string, SyncLedgerEntry>();
  private remoteManifest = new Map<string, SyncManifestEntry>();
  private pendingWants = new Set<string>();
  private incomingWants = new Set<string>();
  private mediaIn = new Map<string, IncomingMedia>();
  private deferred: SyncWireMessage[] = [];
  private seen = new Map<SyncTable, Set<string>>();
  private queue: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();
  private cursorBlock = 0;
  private cursorBlockLeft = 0;
  private since = 0;
  private localThrough = 0;
  private remoteThrough = 0;
  private remoteHello = false;
  private remoteManifestDone = false;
  private localReady = false;
  private wantsSent = false;
  private completeSent = false;
  private remoteComplete: Extract<SyncWireMessage, { type: 'complete' }> | null = null;
  private localDigest = '';
  private done = false;
  private finishing = false;
  private failed = false;
  private applied = 0;
  private deleted = 0;
  private sent = 0;
  private received = 0;
  private bytes = 0;
  private idleTimer: any = 0;
  private startedAt = Date.now();
  private resolveDone!: (summary: SyncSummary) => void;
  private rejectDone!: (error: any) => void;
  private abortHandler: (() => void) | null = null;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  start(): Promise<SyncSummary> {
    if (this.done || this.failed) return Promise.reject(syncError('sync-state'));
    const promise = new Promise<SyncSummary>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.options.channel.setMessageHandler((message) => this.enqueue(message));
    this.options.channel.onClose((reason) => this.fail(syncError(reason === 'timeout' ? 'sync-timeout' : 'sync-disconnected')));
    if (this.options.signal) {
      this.abortHandler = () => this.fail(abortError());
      if (this.options.signal.aborted) this.abortHandler();
      else this.options.signal.addEventListener('abort', this.abortHandler, { once: true });
    }
    void this.begin();
    return promise;
  }

  private async begin() {
    try {
      const storedPeer = await this.options.ledger.getPeer(this.options.peer.deviceId);
      if (storedPeer && (storedPeer.publicJwk?.x !== this.options.peer.publicJwk.x
        || storedPeer.publicJwk?.y !== this.options.peer.publicJwk.y)) {
        throw syncError('sync-identity-changed');
      }
      this.since = Number.isSafeInteger(storedPeer?.peerCursor) && storedPeer?.peerCursor > 0 ? storedPeer.peerCursor : 0;
      await this.send({
        type: 'hello',
        pv: SYNC_PROTOCOL_VERSION,
        deviceId: this.options.identity.deviceId,
        name: this.options.identity.name,
        features: ['media', 'tombstones', 'incremental']
      });
      await this.indexLocal();
      if (this.failed) return;
      this.localReady = true;
      this.emitProgress('manifest');
      const pages = pageManifest([...this.local.values()], this.since);
      for (let i = 0; i < pages.length; i++) {
        await this.send({ type: 'manifest', entries: pages[i], more: i < pages.length - 1, through: this.localThrough });
        if (this.failed) return;
      }
      this.flushQueue();
      this.tryComplete();
    } catch (error) {
      this.fail(error);
    }
  }

  private enqueue(message: SyncWireMessage) {
    if (this.done || this.failed) return;
    this.resetIdle();
    this.queue = this.queue
      .then(() => this.handle(message))
      .catch((error) => this.fail(error));
  }

  private flushQueue() {
    const pending = this.deferred.splice(0, this.deferred.length);
    for (const message of pending) this.enqueue(message);
  }

  private async handle(message: SyncWireMessage) {
    if (this.failed) return;
    if (!this.localReady && message.type !== 'hello') {
      this.deferred.push(message);
      return;
    }
    switch (message.type) {
      case 'hello': return this.handleHello(message);
      case 'manifest': return this.handleManifest(message);
      case 'want': return this.handleWant(message);
      case 'record': return this.handleRecord(message.record);
      case 'media-meta': return this.handleMediaMeta(message);
      case 'media-chunk': return this.handleMediaChunk(message);
      case 'media-end': return this.handleMediaEnd(message);
      case 'missing': return this.handleMissing(message);
      case 'complete': return this.handleComplete(message);
      case 'error': return this.fail(syncError(`sync-peer-${message.code}`));
      default: throw syncError('sync-protocol');
    }
  }

  private handleHello(message: Extract<SyncWireMessage, { type: 'hello' }>) {
    if (message.pv !== SYNC_PROTOCOL_VERSION) throw syncError('sync-version');
    if (message.deviceId !== this.options.peer.deviceId) throw syncError('sync-peer');
    this.remoteHello = true;
    this.resetIdle();
  }

  private async indexLocal() {
    const ledgerRows = await this.options.ledger.all();
    if (ledgerRows.length > SYNC_MAX_ENTRIES) throw syncError('sync-limit');
    this.local = new Map(ledgerRows.map((entry) => [entry.key, entry]));
    this.localThrough = ledgerRows.reduce((max, entry) => Math.max(max, entry.cursor), 0);
    this.emitProgress('preparing', 0, 0, 'scan');
    const allTrips = await this.options.data.allTrips();
    const tripMap = new Map<string, any>(allTrips.map((trip) => [trip.id, trip]));
    // Never expose an in-progress recording that has not been synced before.
    // Once a trip was synced while finished, keep it convergent if it is resumed.
    const excluded = new Set<string>(allTrips
      .filter((trip) => (trip.status === 'recording' || trip.status === 'paused')
        && !this.local.has(syncKey('trips', trip.id)))
      .map((trip) => trip.id));
    const changed: SyncLedgerEntry[] = [];
    let processed = 0;

    for (const table of ['trips', 'segments', 'media', 'trackChunks', 'waypoints'] as SyncTable[]) {
      const seen = new Set<string>();
      this.seen.set(table, seen);
      await this.options.data.eachRow(table, async (row) => {
        if (this.failed) return;
        if (!row || typeof row.id !== 'string') throw syncError('sync-data');
        const trip = table === 'trips' ? row : tripMap.get(row.tripId);
        if (!trip || excluded.has(trip.id)) return;
        const key = syncKey(table, row.id);
        const previous = this.local.get(key);
        let entry: SyncLedgerEntry;
        if (table === 'media') {
          entry = await this.indexMediaRow(row, trip, previous);
        } else {
          entry = await this.indexRow(table, row, trip, previous);
        }
        if (entry !== previous) {
          this.local.set(key, entry);
          changed.push(entry);
          if (changed.length >= 200) {
            const batch = changed.splice(0, changed.length);
            await this.options.ledger.putMany(batch);
          }
        }
        seen.add(row.id);
        processed++;
        if (processed % 40 === 0) this.emitProgress('preparing', processed, 0, table);
      });
      const tableTombstones: SyncLedgerEntry[] = [];
      for (const entry of this.local.values()) {
        if (entry.table !== table || seen.has(entry.id)) continue;
        if (this.keepMissingEntry(entry, tripMap, excluded)) continue;
        if (entry.deleted) continue;
        const tombstone = await this.tombstoneEntry(entry);
        this.local.set(tombstone.key, tombstone);
        tableTombstones.push(tombstone);
      }
      if (tableTombstones.length) {
        changed.push(...tableTombstones);
        await this.options.ledger.putMany(tableTombstones);
      }
      if (this.failed) return;
    }
    if (changed.length) await this.options.ledger.putMany(changed.splice(0, changed.length));
    this.localThrough = Math.max(this.localThrough, ...[...this.local.values()].map((entry) => entry.cursor));
    const peerCursor = this.since;
    if (peerCursor > this.localThrough) this.since = 0;
    this.emitProgress('preparing', processed, processed, 'digest');
  }

  private async indexRow(table: SyncTable, row: any, trip: any, previous: SyncLedgerEntry | undefined) {
    const hash = await syncRecordHash(table, row);
    const key = syncKey(table, row.id);
    if (previous && !previous.deleted && previous.hash === hash) {
      if (previous.tripId !== row.tripId) return { ...previous, tripId: row.tripId };
      return previous;
    }
    const cursor = await this.allocateCursor();
    return {
      key, table, id: row.id, tripId: table === 'trips' ? undefined : row.tripId,
      hash, stamp: nextLocalStamp(previous, baseRecordStamp(table, row, trip)),
      deviceId: this.options.identity.deviceId, cursor, at: Date.now(), deleted: false
    } as SyncLedgerEntry;
  }

  private async indexMediaRow(row: any, trip: any, previous: SyncLedgerEntry | undefined) {
    const blob: Blob | undefined = row.blob;
    const thumb: Blob | undefined = row.thumb;
    const reusable = previous && !previous.deleted && previous.blobHash && previous.thumbHash
      && previous.blobSize === (blob?.size || 0) && previous.blobType === (blob?.type || '')
      && previous.thumbSize === (thumb?.size || 0) && previous.thumbType === (thumb?.type || '');
    const blobHash = reusable ? previous!.blobHash! : await blobDigest(blob);
    const thumbHash = reusable ? previous!.thumbHash! : await blobDigest(thumb);
    const hash = await syncRecordHash('media', row, { blobHash, thumbHash });
    const key = syncKey('media', row.id);
    const base = {
      key, table: 'media' as const, id: row.id, tripId: row.tripId, hash,
      blobHash, thumbHash, blobSize: blob?.size || 0, blobType: blob?.type || '',
      thumbSize: thumb?.size || 0, thumbType: thumb?.type || ''
    };
    if (previous && !previous.deleted && previous.hash === hash) {
      const unchanged = previous.tripId === row.tripId && previous.blobHash === blobHash
        && previous.thumbHash === thumbHash && previous.blobSize === base.blobSize;
      return unchanged ? previous : { ...previous, ...base };
    }
    return {
      ...base,
      stamp: nextLocalStamp(previous, baseRecordStamp('media', row, trip)),
      deviceId: this.options.identity.deviceId, cursor: await this.allocateCursor(),
      at: Date.now(), deleted: false
    } as SyncLedgerEntry;
  }

  private keepMissingEntry(entry: SyncLedgerEntry, tripMap: Map<string, any>, excluded: Set<string>) {
    if (entry.table === 'trips') return tripMap.has(entry.id) && excluded.has(entry.id);
    if (entry.tripId) return excluded.has(entry.tripId);
    return false;
  }

  private async tombstoneEntry(entry: SyncLedgerEntry): Promise<SyncLedgerEntry> {
    return {
      ...entry,
      hash: '',
      stamp: nextLocalStamp(entry, entry.stamp),
      deviceId: this.options.identity.deviceId,
      cursor: await this.allocateCursor(),
      at: Date.now(),
      deleted: true,
      blobHash: undefined, thumbHash: undefined, blobSize: undefined, thumbSize: undefined,
      blobType: undefined, thumbType: undefined
    };
  }

  private async allocateCursor() {
    if (this.cursorBlockLeft <= 0) await this.refillCursors();
    this.cursorBlockLeft--;
    return this.cursorBlock++;
  }

  private async refillCursors() {
    this.cursorBlock = await this.options.ledger.allocateCursors(512);
    this.cursorBlockLeft = 512;
  }

  private async handleManifest(message: Extract<SyncWireMessage, { type: 'manifest' }>) {
    if (!this.remoteHello) throw syncError('sync-protocol');
    for (const wire of message.entries) {
      const key = syncKey(wire.t, wire.id);
      const existing = this.remoteManifest.get(key);
      if (existing && (existing.h !== wire.h || existing.del !== wire.del || existing.st !== wire.st || existing.dev !== wire.dev)) {
        throw syncError('sync-protocol');
      }
      this.remoteManifest.set(key, {
        t: wire.t, id: wire.id, h: wire.h, st: wire.st, dev: wire.dev, ...(wire.del ? { del: true } : {})
      });
      if (this.remoteManifest.size > SYNC_MAX_ENTRIES) throw syncError('sync-limit');
    }
    this.remoteThrough = Math.max(this.remoteThrough, message.through);
    if (message.more) return;
    this.remoteManifestDone = true;
    await this.reconcileManifest();
  }

  private async reconcileManifest() {
    if (!this.remoteManifestDone) return;
    const adoptTombstones: SyncManifestEntry[] = [];
    const adoptVersions: SyncManifestEntry[] = [];
    for (const remote of this.remoteManifest.values()) {
      const key = syncKey(remote.t, remote.id);
      const local = this.local.get(key);
      if (remote.del) {
        if (!local) adoptTombstones.push(remote);
        else if (local.deleted) {
          if (compareSyncVersions(remote, { st: local.stamp, dev: local.deviceId, h: local.hash, del: true }) > 0) {
            adoptTombstones.push(remote);
          }
        } else if (remoteWins(remote, local)) adoptTombstones.push(remote);
        continue;
      }
      if (!local || local.deleted) {
        this.pendingWants.add(key);
      } else if (local.hash !== remote.h) {
        if (remoteWins(remote, local)) this.pendingWants.add(key);
      } else if ((remote.st !== local.stamp || remote.dev !== local.deviceId)
        && compareSyncVersions(remote, { st: local.stamp, dev: local.deviceId, h: local.hash, del: false }) > 0) {
        // Identical bytes still need a single deterministic ledger version so
        // both final digests match without re-transferring the record.
        adoptVersions.push(remote);
      }
    }
    for (const remote of adoptTombstones) await this.applyRemoteTombstone(remote);
    for (const remote of adoptVersions) await this.adoptRemoteVersion(remote);
    await this.maybeSendWants();
    this.tryComplete();
  }

  private async adoptRemoteVersion(remote: SyncManifestEntry) {
    const key = syncKey(remote.t, remote.id);
    const current = this.local.get(key);
    if (!current) return;
    const entry: SyncLedgerEntry = {
      ...current, stamp: remote.st, deviceId: remote.dev, hash: remote.h,
      cursor: await this.allocateCursor(), at: Date.now(), deleted: false
    };
    this.local.set(key, entry);
    this.localThrough = Math.max(this.localThrough, entry.cursor);
    await this.options.ledger.put(entry);
  }

  private async applyRemoteTombstone(remote: SyncManifestEntry) {
    const key = syncKey(remote.t, remote.id);
    const entry: SyncLedgerEntry = {
      key, table: remote.t, id: remote.id,
      tripId: this.local.get(key)?.tripId,
      hash: '', stamp: remote.st, deviceId: remote.dev, deleted: true,
      cursor: await this.allocateCursor(), at: Date.now()
    };
    this.local.set(key, entry);
    this.localThrough = Math.max(this.localThrough, entry.cursor);
    this.deleted++;
    await this.options.data.deleteRow(remote.t, remote.id);
    await this.options.ledger.put(entry);
    this.emitProgress('transfer');
  }

  private async maybeSendWants() {
    if (!this.remoteManifestDone || this.wantsSent) return;
    this.wantsSent = true;
    const keys = [...this.pendingWants].map((key) => {
      const separator = key.indexOf(':');
      return { t: key.slice(0, separator) as SyncTable, id: key.slice(separator + 1) };
    }).sort((a, b) => TABLE_ORDER[a.t] - TABLE_ORDER[b.t] || a.id.localeCompare(b.id));
    if (!keys.length) {
      this.tryComplete();
      return;
    }
    for (let i = 0; i < keys.length; i += SYNC_MAX_WANT_KEYS) {
      await this.send({ type: 'want', keys: keys.slice(i, i + SYNC_MAX_WANT_KEYS) });
      if (this.failed) return;
    }
    if (this.pendingWants.size) this.emitProgress('transfer', 0, this.pendingWants.size);
    this.tryComplete();
  }

  private handleWant(message: Extract<SyncWireMessage, { type: 'want' }>) {
    for (const key of message.keys) {
      const id = syncKey(key.t, key.id);
      if (this.incomingWants.has(id)) continue;
      this.incomingWants.add(id);
      this.outbound = this.outbound
        .then(() => this.fulfillWant(key.t, key.id))
        .catch((error) => this.fail(error));
    }
  }

  private async fulfillWant(table: SyncTable, id: string) {
    if (this.failed) return;
    const key = syncKey(table, id);
    const entry = this.local.get(key);
    if (!entry || entry.deleted) {
      await this.send({ type: 'missing', keys: [{ t: table, id }] });
      this.incomingWants.delete(key);
      this.tryComplete();
      return;
    }
    const row = await this.options.data.getRow(table, id);
    if (!row) {
      this.local.delete(key);
      await this.send({ type: 'missing', keys: [{ t: table, id }] });
      this.incomingWants.delete(key);
      this.tryComplete();
      return;
    }
    if (table === 'media') {
      await this.sendMedia(entry, row);
    } else {
      const hash = await syncRecordHash(table, row);
      if (hash !== entry.hash) throw syncError('sync-local-changed');
      const payload: SyncRecordPayload = {
        t: table, id, data: syncRecordData(table, row), h: hash
      };
      await this.send({ type: 'record', record: payload });
      this.sent++;
      this.emitProgress('transfer');
    }
    this.incomingWants.delete(key);
    this.tryComplete();
  }

  private async sendMedia(entry: SyncLedgerEntry, row: any) {
    const blob: Blob = row.blob;
    const thumb: Blob = row.thumb || new Blob([], { type: entry.thumbType || '' });
    if (!entry.blobHash || !entry.thumbHash) throw syncError('sync-local-changed');
    if ((blob?.size || 0) !== entry.blobSize || (thumb?.size || 0) !== entry.thumbSize) {
      throw syncError('sync-local-changed');
    }
    const data = syncRecordData('media', row, { blobHash: entry.blobHash, thumbHash: entry.thumbHash });
    const payload: SyncRecordPayload = {
      t: 'media', id: entry.id, data, h: entry.hash,
      blobHash: entry.blobHash, thumbHash: entry.thumbHash
    };
    await this.send({
      type: 'media-meta', record: payload,
      blobSize: entry.blobSize || 0, thumbSize: entry.thumbSize || 0,
      blobType: entry.blobType || '', thumbType: entry.thumbType || ''
    });
    for (const part of ['blob', 'thumb'] as const) {
      const source = part === 'blob' ? blob : thumb;
      const total = source?.size || 0;
      for (let offset = 0; offset < total; offset += SYNC_MEDIA_CHUNK_BYTES) {
        const slice = source.slice(offset, Math.min(total, offset + SYNC_MEDIA_CHUNK_BYTES));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        await this.send({
          type: 'media-chunk', t: 'media', id: entry.id, part,
          index: Math.floor(offset / SYNC_MEDIA_CHUNK_BYTES),
          data: b64urlEncode(bytes)
        });
        this.bytes += bytes.length;
      }
    }
    await this.send({ type: 'media-end', t: 'media', id: entry.id });
    this.sent++;
    this.emitProgress('transfer');
  }

  private handleRecord(payload: SyncRecordPayload) {
    const key = syncKey(payload.t, payload.id);
    if (!this.pendingWants.has(key)) return;
    if (payload.t === 'media') throw syncError('sync-protocol');
    return this.applyRecord(payload);
  }

  private async applyRecord(payload: SyncRecordPayload) {
    const key = syncKey(payload.t, payload.id);
    const remote = this.remoteManifest.get(key);
    if (!remote || remote.del || remote.h !== payload.h) throw syncError('sync-hash');
    await verifyWireRecordHash(payload, { blobHash: payload.blobHash, thumbHash: payload.thumbHash });
    const row = payload.data;
    const invalid = validateRemoteRow(payload.t, row);
    if (invalid) throw syncError('sync-data');
    if (payload.t === 'trips' && (row.status === 'recording' || row.status === 'paused')) {
      throw syncError('sync-data');
    }
    if (payload.t !== 'trips') {
      const parent = await this.options.data.getRow('trips', row.tripId);
      if (!parent) throw syncError('sync-data');
    }
    await this.options.data.putRow(payload.t, row);
    await this.recordApplied(payload, remote, row.tripId);
    this.pendingWants.delete(key);
    this.received++;
    this.applied++;
    this.bytes += JSON.stringify(payload).length;
    this.emitProgress('transfer', this.applied, Math.max(1, this.applied + this.pendingWants.size));
    this.tryComplete();
  }

  private async recordApplied(payload: SyncRecordPayload, remote: SyncManifestEntry, tripId?: string) {
    const key = syncKey(payload.t, payload.id);
    const entry: SyncLedgerEntry = {
      key, table: payload.t, id: payload.id, tripId: payload.t === 'trips' ? undefined : tripId,
      hash: payload.h, stamp: remote.st, deviceId: remote.dev,
      cursor: await this.allocateCursor(), at: Date.now(), deleted: false,
      ...(payload.blobHash ? { blobHash: payload.blobHash } : {}),
      ...(payload.thumbHash ? { thumbHash: payload.thumbHash } : {})
    };
    this.local.set(key, entry);
    this.localThrough = Math.max(this.localThrough, entry.cursor);
    await this.options.ledger.put(entry);
  }

  private handleMediaMeta(message: Extract<SyncWireMessage, { type: 'media-meta' }>) {
    const key = syncKey('media', message.record.id);
    if (!this.pendingWants.has(key)) return;
    const remote = this.remoteManifest.get(key);
    if (!remote || remote.del || remote.h !== message.record.h) throw syncError('sync-hash');
    if (this.mediaIn.has(key)) throw syncError('sync-protocol');
    if (message.blobSize + message.thumbSize > SYNC_MAX_MEDIA_BYTES * 2) throw syncError('sync-limit');
    this.mediaIn.set(key, {
      entry: remote,
      payload: message.record,
      blobSize: message.blobSize,
      thumbSize: message.thumbSize,
      blobType: message.blobType,
      thumbType: message.thumbType,
      chunks: new Map(),
      received: 0,
      bytes: message.blobSize + message.thumbSize
    });
    this.emitProgress('transfer', this.applied, Math.max(1, this.applied + this.pendingWants.size), 'media');
  }

  private handleMediaChunk(message: Extract<SyncWireMessage, { type: 'media-chunk' }>) {
    const key = syncKey('media', message.id);
    const transfer = this.mediaIn.get(key);
    if (!transfer) return;
    const size = message.part === 'blob' ? transfer.blobSize : transfer.thumbSize;
    if (message.index * SYNC_MEDIA_CHUNK_BYTES >= size && size !== 0) throw syncError('sync-limit');
    const id = `${message.part}:${message.index}`;
    const bytes = b64urlDecode(message.data);
    if (bytes.length > SYNC_MEDIA_CHUNK_BYTES || bytes.length === 0) throw syncError('sync-limit');
    const existing = transfer.chunks.get(id);
    if (existing) {
      if (existing.length !== bytes.length) throw syncError('sync-protocol');
      return;
    }
    transfer.chunks.set(id, bytes);
    transfer.received += bytes.length;
    this.bytes += bytes.length;
    this.emitProgress('transfer', this.applied, Math.max(1, this.applied + this.pendingWants.size), 'media');
  }

  private async handleMediaEnd(message: Extract<SyncWireMessage, { type: 'media-end' }>) {
    const key = syncKey('media', message.id);
    const transfer = this.mediaIn.get(key);
    if (!transfer) return;
    this.mediaIn.delete(key);
    if (transfer.received !== transfer.blobSize + transfer.thumbSize) throw syncError('sync-hash');
    const blob = this.joinChunks(transfer, 'blob', transfer.blobSize, transfer.blobType);
    const thumb = this.joinChunks(transfer, 'thumb', transfer.thumbSize, transfer.thumbType);
    const blobHash = await blobDigest(blob);
    const thumbHash = await blobDigest(thumb);
    if (blobHash !== transfer.payload.blobHash || thumbHash !== transfer.payload.thumbHash) throw syncError('sync-hash');
    await verifyWireRecordHash(transfer.payload, { blobHash, thumbHash });
    const data = transfer.payload.data;
    if (Number(data.blobSize) !== transfer.blobSize || Number(data.thumbSize) !== transfer.thumbSize) {
      throw syncError('sync-hash');
    }
    const invalid = validateRemoteRow('media', data);
    if (invalid) throw syncError('sync-data');
    const parent = await this.options.data.getRow('trips', data.tripId);
    if (!parent) throw syncError('sync-data');
    const row = {
      ...data,
      blob,
      thumb
    };
    for (const field of ['blobSize', 'blobType', 'thumbSize', 'thumbType', '_blobHash', '_thumbHash']) delete row[field];
    await this.options.data.putRow('media', row);
    await this.recordApplied(transfer.payload, transfer.entry, data.tripId);
    this.pendingWants.delete(key);
    this.received++;
    this.applied++;
    this.emitProgress('transfer', this.applied, Math.max(1, this.applied + this.pendingWants.size));
    this.tryComplete();
  }

  private joinChunks(transfer: IncomingMedia, part: 'blob' | 'thumb', size: number, type: string) {
    const parts: Uint8Array[] = [];
    const count = Math.ceil(size / SYNC_MEDIA_CHUNK_BYTES);
    for (let index = 0; index < count; index++) {
      const chunk = transfer.chunks.get(`${part}:${index}`);
      if (!chunk) throw syncError('sync-hash');
      parts.push(chunk);
    }
    return new Blob(parts as unknown as BlobPart[], { type });
  }

  private handleMissing(message: Extract<SyncWireMessage, { type: 'missing' }>) {
    for (const key of message.keys) this.pendingWants.delete(syncKey(key.t, key.id));
    this.tryComplete();
  }

  private handleComplete(message: Extract<SyncWireMessage, { type: 'complete' }>) {
    this.remoteComplete = message;
    this.remoteThrough = Math.max(this.remoteThrough, message.through);
    if (this.completeSent && this.localDigest) void this.finish(this.localDigest).catch((error) => this.fail(error));
    else this.tryComplete();
  }

  private tryComplete() {
    if (this.failed || this.done || this.completeSent) return;
    if (!this.remoteHello || !this.localReady || !this.remoteManifestDone || !this.wantsSent) return;
    if (this.pendingWants.size || this.incomingWants.size || this.mediaIn.size) return;
    this.completeSent = true;
    this.emitProgress('verifying');
    this.digestAndSendComplete().catch((error) => this.fail(error));
  }

  private async digestAndSendComplete() {
    const digest = await digestLedger([...this.local.values()]);
    this.localDigest = digest;
    await this.send({
      type: 'complete', digest, through: this.localThrough,
      applied: this.applied, received: this.received, sent: this.sent
    });
    if (this.remoteComplete) await this.finish(digest);
  }

  private async finish(localDigest: string) {
    if (this.done || this.failed || this.finishing) return;
    const remote = this.remoteComplete;
    if (!remote) return;
    this.finishing = true;
    if (remote.digest !== localDigest) {
      const previous = await this.options.ledger.getPeer(this.options.peer.deviceId);
      if (previous) await this.options.ledger.putPeer({ ...previous, peerCursor: 0 });
      throw syncError('sync-verify');
    }
    clearTimeout(this.idleTimer);
    this.cleanupAbort();
    const peerRecord: SyncPeerRecord = {
      deviceId: this.options.peer.deviceId,
      name: this.options.peer.name,
      publicJwk: this.options.peer.publicJwk,
      fingerprint: this.options.peer.fingerprint,
      lastSyncAt: Date.now(),
      peerCursor: remote.through,
      direction: this.options.direction,
      records: this.received,
      bytes: this.bytes
    };
    try {
      await this.options.ledger.putPeer(peerRecord);
    } catch (error) {
      this.finishing = false;
      throw error;
    }
    if (this.failed) return;
    this.done = true;
    this.emitProgress('done');
    this.resolveDone({
      peer: this.options.peer,
      applied: this.applied,
      deleted: this.deleted,
      sent: this.sent,
      received: this.received,
      bytes: this.bytes,
      digest: localDigest,
      direction: this.options.direction
    });
  }

  private async send(message: SyncWireMessage) {
    if (this.failed || this.done) return;
    this.resetIdle();
    await this.options.channel.send(message);
  }

  private emitProgress(phase: SyncPhase, applied = this.applied, total = this.pendingWants.size + this.applied, detail?: string) {
    this.options.onProgress?.({
      phase,
      peerName: this.options.peer.name,
      applied,
      total,
      sent: this.sent,
      received: this.received,
      bytes: this.bytes,
      detail
    });
  }

  private resetIdle() {
    clearTimeout(this.idleTimer);
    if (this.done || this.failed) return;
    const age = Date.now() - this.startedAt;
    const timeout = age < 90_000 ? 90_000 : 10 * 60_000;
    this.idleTimer = setTimeout(() => this.fail(syncError('sync-timeout')), timeout);
  }

  private fail(error: any) {
    if (this.done || this.failed) return;
    this.failed = true;
    clearTimeout(this.idleTimer);
    this.cleanupAbort();
    try { this.options.channel.close(); } catch { /* already closed */ }
    this.rejectDone(error?.code ? error : syncError('sync-failed'));
  }

  private cleanupAbort() {
    if (this.options.signal && this.abortHandler) {
      this.options.signal.removeEventListener('abort', this.abortHandler);
      this.abortHandler = null;
    }
  }
}
