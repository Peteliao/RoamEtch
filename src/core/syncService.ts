// Unified sync boundary: pairing, identity and the bidirectional session.
// UI code uses this service instead of wiring transport, engine and Dexie itself.
import {
  createSyncInvite, fingerprintForPublicJwk, isSelfInvite, parseSyncInvite, verifySyncInvite,
  type SyncDeviceIdentity
} from './syncIdentity';
import { connectSyncPeer, type SyncTransportStatus } from './syncTransport';
import { SyncSession, type SyncProgress, type SyncSummary } from './syncEngine';
import type { SyncPairingInvite } from './syncProtocol';
import { syncDataRepository } from './syncDataRepository';
import {
  eraseSyncState, loadOrCreateSyncIdentity, removeSyncPeer, saveSyncIdentityName,
  syncIdentityFingerprint, syncLedgerStore, syncStateSummary, type SyncPeerRecord
} from './syncStore';

export type SyncInvite = SyncPairingInvite & { code: string };
export type { SyncDeviceIdentity, SyncProgress, SyncSummary, SyncTransportStatus, SyncPairingInvite, SyncPeerRecord };

export interface SyncRunOptions {
  identity: SyncDeviceIdentity;
  invite: SyncPairingInvite;
  role: 'initiator' | 'responder';
  signal?: AbortSignal;
  onStatus?: (status: SyncTransportStatus) => void;
  onProgress?: (progress: SyncProgress) => void;
  timeoutMs?: number;
}

export interface SyncService {
  loadIdentity(displayName?: string): Promise<SyncDeviceIdentity>;
  renameIdentity(identity: SyncDeviceIdentity, name: string): Promise<SyncDeviceIdentity>;
  fingerprint(identity: SyncDeviceIdentity): Promise<string>;
  createInvite(identity: SyncDeviceIdentity, options?: { ttlMs?: number; name?: string }): Promise<SyncInvite>;
  parseInvite(raw: string): SyncPairingInvite | null;
  verifyInvite(invite: SyncPairingInvite): Promise<boolean>;
  isSelfInvite(invite: SyncPairingInvite, identity: SyncDeviceIdentity): boolean;
  hostFingerprint(invite: SyncPairingInvite): Promise<string>;
  listPeers(): Promise<SyncPeerRecord[]>;
  removePeer(deviceId: string): Promise<void>;
  sync(options: SyncRunOptions): Promise<SyncSummary>;
  summary(): Promise<any>;
  erase(): Promise<void>;
}

export const syncService: SyncService = {
  loadIdentity: (displayName = '') => loadOrCreateSyncIdentity(displayName),
  renameIdentity: (identity, name) => saveSyncIdentityName(identity, name),
  fingerprint: (identity) => syncIdentityFingerprint(identity),
  createInvite: (identity, options) => createSyncInvite(identity, options),
  parseInvite: (raw) => parseSyncInvite(raw),
  verifyInvite: (invite) => verifySyncInvite(invite),
  isSelfInvite: (invite, identity) => isSelfInvite(invite, identity),
  hostFingerprint: (invite) => fingerprintForPublicJwk(invite.jwk),
  listPeers: () => syncLedgerStore().listPeers(),
  removePeer: (deviceId) => removeSyncPeer(deviceId),
  async sync(options) {
    const connection = await connectSyncPeer({
      invite: options.invite,
      identity: options.identity,
      role: options.role,
      signal: options.signal,
      onStatus: options.onStatus,
      timeoutMs: options.timeoutMs
    });
    try {
      const session = new SyncSession({
        identity: options.identity,
        peer: connection.peer,
        channel: connection.channel,
        ledger: syncLedgerStore(),
        data: syncDataRepository,
        direction: options.role === 'initiator' ? 'sent' : 'received',
        signal: options.signal,
        onProgress: options.onProgress
      });
      return await session.start();
    } finally {
      connection.close();
    }
  },
  summary: () => syncStateSummary(),
  erase: () => eraseSyncState()
};
