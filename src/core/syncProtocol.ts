// Device-to-device sync protocol: deterministic record hashes, ledger versions,
// manifest paging, incremental cursors and a final whole-ledger digest.
import { sha256Hex, stableStringify } from './integrity';

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_MANIFEST_PAGE = 400;
export const SYNC_MAX_WIRE_BYTES = 384 * 1024;
export const SYNC_MAX_WANT_KEYS = 2000;
export const SYNC_MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const SYNC_MEDIA_CHUNK_BYTES = 16 * 1024;
export const SYNC_MAX_TRACK_POINTS = 2000;
export const SYNC_MAX_ENTRIES = 1_000_000;

export const SYNC_TABLES = ['trips', 'segments', 'media', 'trackChunks', 'waypoints'] as const;
export type SyncTable = typeof SYNC_TABLES[number];

const SYNC_TABLE_SET = new Set<string>(SYNC_TABLES);
const TOMBSTONE_HASH = '';

const DERIVED_TRIP_FIELDS = ['statsCache', 'thumbPoints', 'reportedDistance'] as const;
const MEDIA_BINARY_FIELDS = ['blob', 'thumb'] as const;
const MEDIA_SIZE_FIELDS = ['blobSize', 'blobType', 'thumbSize', 'thumbType'] as const;

export interface SyncVersion {
  st: number;
  dev: string;
  del?: boolean;
  h: string;
}

export interface SyncLedgerEntry {
  key: string;
  table: SyncTable;
  id: string;
  tripId?: string;
  hash: string;
  stamp: number;
  deviceId: string;
  deleted: boolean;
  cursor: number;
  at: number;
  blobHash?: string;
  thumbHash?: string;
  blobSize?: number;
  thumbSize?: number;
  blobType?: string;
  thumbType?: string;
}

export interface SyncWireEntry {
  t: SyncTable;
  id: string;
  h: string;
  st: number;
  dev: string;
  del?: true;
}

export interface SyncRecordPayload {
  t: SyncTable;
  id: string;
  data: any;
  h: string;
  blobHash?: string;
  thumbHash?: string;
}

export type SyncWireMessage =
  | { type: 'hello'; pv: number; deviceId: string; name: string; features: string[] }
  | { type: 'manifest'; entries: SyncWireEntry[]; more: boolean; through: number }
  | { type: 'want'; keys: { t: SyncTable; id: string }[] }
  | { type: 'record'; record: SyncRecordPayload }
  | { type: 'media-meta'; record: SyncRecordPayload; blobSize: number; thumbSize: number; blobType: string; thumbType: string }
  | { type: 'media-chunk'; t: 'media'; id: string; part: 'blob' | 'thumb'; index: number; data: string }
  | { type: 'media-end'; t: 'media'; id: string }
  | { type: 'missing'; keys: { t: SyncTable; id: string }[] }
  | { type: 'complete'; digest: string; through: number; applied: number; received: number; sent: number }
  | { type: 'error'; code: string };

export interface SyncManifestEntry extends SyncVersion {
  t: SyncTable;
  id: string;
}

export interface SyncPeerIdentity {
  deviceId: string;
  name: string;
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  fingerprint?: string;
}

export interface SyncPairingInvite {
  v: number;
  kind: 'sync';
  room: string;
  secret: string;
  sid: string;
  deviceId: string;
  name: string;
  jwk: SyncPeerIdentity['publicJwk'];
  exp: number;
}

export function isSyncTable(value: unknown): value is SyncTable {
  return typeof value === 'string' && SYNC_TABLE_SET.has(value);
}

export function syncKey(table: SyncTable, id: string) {
  return `${table}:${id}`;
}

export function splitSyncKey(key: string): { table: SyncTable; id: string } {
  const at = key.indexOf(':');
  const table = key.slice(0, at);
  const id = key.slice(at + 1);
  if (at < 1 || !isSyncTable(table) || !validRecordId(id)) throw new Error('sync-key');
  return { table, id };
}

export function validRecordId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 160 && /^[A-Za-z0-9_.:@-]+$/.test(id);
}

function stripFields(value: any, fields: readonly string[]) {
  const out = { ...(value || {}) };
  for (const field of fields) delete out[field];
  return out;
}

/** Wire data deliberately drops locally derivable fields and binary blobs. */
export function syncRecordData(table: SyncTable, row: any, blobHashes?: { blobHash?: string; thumbHash?: string }) {
  if (!row || typeof row !== 'object') throw new Error('sync-record');
  if (table === 'media') {
    const meta = stripFields(stripFields(row, MEDIA_BINARY_FIELDS), MEDIA_SIZE_FIELDS);
    const blob = row.blob;
    const thumb = row.thumb;
    return {
      ...meta,
      blobSize: blob?.size ?? row.blobSize ?? 0,
      blobType: blob?.type ?? row.blobType ?? '',
      thumbSize: thumb?.size ?? row.thumbSize ?? 0,
      thumbType: thumb?.type ?? row.thumbType ?? '',
      ...(blobHashes?.blobHash || row.blobHash ? { _blobHash: blobHashes?.blobHash || row.blobHash } : {}),
      ...(blobHashes?.thumbHash || row.thumbHash ? { _thumbHash: blobHashes?.thumbHash || row.thumbHash } : {})
    };
  }
  if (table === 'trips') return stripFields(row, DERIVED_TRIP_FIELDS);
  return { ...row };
}

function hashInput(table: SyncTable, row: any, hashes?: { blobHash?: string; thumbHash?: string }) {
  const data = syncRecordData(table, row, hashes);
  if (table === 'media') {
    const { _blobHash, _thumbHash, ...meta } = data;
    return { ...meta, blobHash: _blobHash || '', thumbHash: _thumbHash || '' };
  }
  return data;
}

export async function syncRecordHash(table: SyncTable, row: any, hashes?: { blobHash?: string; thumbHash?: string }) {
  return sha256Hex(stableStringify(hashInput(table, row, hashes)));
}

export async function blobDigest(blob: Blob | null | undefined) {
  if (!blob || !blob.size) return '';
  return sha256Hex(await blob.arrayBuffer());
}

export function baseRecordStamp(table: SyncTable, row: any, trip: any) {
  if (table === 'trips') return finiteStamp(row?.updatedAt ?? row?.createdAt);
  return finiteStamp(trip?.updatedAt ?? row?.updatedAt ?? row?.time ?? row?.createdAt);
}

export function finiteStamp(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

/** A locally edited record must supersede the ledger version it replaces. */
export function nextLocalStamp(previous: { st?: number; stamp?: number } | null | undefined, base: number) {
  const floor = previous ? Math.max(0, finiteStamp(previous.st ?? previous.stamp)) : 0;
  return Math.max(finiteStamp(base), previous ? floor + 1 : floor);
}

export function compareSyncVersions(a: SyncVersion, b: SyncVersion) {
  if (a.st !== b.st) return a.st - b.st;
  const device = String(a.dev || '').localeCompare(String(b.dev || ''));
  if (device) return device;
  const deleted = Number(!!a.del) - Number(!!b.del);
  if (deleted) return deleted;
  return String(a.h || '').localeCompare(String(b.h || ''));
}

function asVersion(value: SyncVersion | SyncLedgerEntry | null | undefined): SyncVersion | null {
  if (!value) return null;
  if ('st' in value) return value as SyncVersion;
  return { st: value.stamp, dev: value.deviceId, h: value.hash, del: value.deleted };
}

/** True when the remote version deterministically wins over the local one. */
export function remoteWins(remote: SyncVersion, local: SyncVersion | SyncLedgerEntry | null | undefined) {
  const current = asVersion(local);
  if (!current) return true;
  if (remote.h === current.h && !!remote.del === !!current.del) return false;
  return compareSyncVersions(remote, current) > 0;
}

export function manifestEntry(entry: SyncLedgerEntry): SyncWireEntry {
  return {
    t: entry.table, id: entry.id, h: entry.deleted ? TOMBSTONE_HASH : entry.hash,
    st: entry.stamp, dev: entry.deviceId, ...(entry.deleted ? { del: true as const } : {})
  };
}

export async function digestLedger(entries: SyncLedgerEntry[]) {
  const lines = [...entries]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => [entry.key, entry.hash, entry.stamp, entry.deviceId, entry.deleted ? 1 : 0].join('|'));
  return sha256Hex(lines.join('\n'));
}

function wireEntry(entry: SyncLedgerEntry): SyncWireEntry {
  return manifestEntry(entry);
}

export function pageManifest(entries: SyncLedgerEntry[], since: number, pageSize = SYNC_MANIFEST_PAGE) {
  const sinceCursor = Number.isSafeInteger(since) && since > 0 ? since : 0;
  const eligible = entries
    .filter((entry) => entry.cursor > sinceCursor)
    .sort((a, b) => a.cursor - b.cursor || a.key.localeCompare(b.key));
  const pages: SyncWireEntry[][] = [];
  for (let i = 0; i < eligible.length; i += pageSize) {
    pages.push(eligible.slice(i, i + pageSize).map(wireEntry));
  }
  if (!pages.length) pages.push([]);
  return pages;
}

export function validateSyncWireEntry(value: any): SyncWireEntry | null {
  if (!value || typeof value !== 'object') return null;
  if (!isSyncTable(value.t) || !validRecordId(value.id)) return null;
  if (typeof value.st !== 'number' || !Number.isSafeInteger(value.st) || value.st < 0) return null;
  if (typeof value.dev !== 'string' || !/^[A-Za-z0-9_.-]{4,80}$/.test(value.dev)) return null;
  if (typeof value.h !== 'string' || (value.h && !/^[a-f0-9]{64}$/.test(value.h))) return null;
  if (value.del === true && value.h) return null;
  if (value.del !== true && !value.h) return null;
  return {
    t: value.t, id: value.id, h: value.h, st: value.st, dev: value.dev,
    ...(value.del === true ? { del: true as const } : {})
  };
}

export function parseSyncWire(raw: string): SyncWireMessage {
  if (typeof raw !== 'string' || !raw || raw.length * 2 > SYNC_MAX_WIRE_BYTES * 3) throw new Error('sync-message');
  let value: any;
  try { value = JSON.parse(raw); } catch { throw new Error('sync-message'); }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new Error('sync-message');
  switch (value.type) {
    case 'hello': {
      if (typeof value.pv !== 'number' || value.pv !== SYNC_PROTOCOL_VERSION) throw new Error('sync-version');
      if (typeof value.deviceId !== 'string' || !/^dev-[A-Za-z0-9_-]{6,40}$/.test(value.deviceId)) throw new Error('sync-peer');
      const name = sanitizePeerName(value.name);
      const features = Array.isArray(value.features)
        ? value.features.filter((f) => typeof f === 'string' && f.length <= 40).slice(0, 16)
        : [];
      return { type: 'hello', pv: value.pv, deviceId: value.deviceId, name, features };
    }
    case 'manifest': {
      if (!Array.isArray(value.entries) || value.entries.length > SYNC_MANIFEST_PAGE) throw new Error('sync-message');
      const entries = value.entries.map(validateSyncWireEntry);
      if (entries.some((entry) => !entry)) throw new Error('sync-message');
      if (typeof value.more !== 'boolean') throw new Error('sync-message');
      if (typeof value.through !== 'number' || !Number.isSafeInteger(value.through) || value.through < 0) throw new Error('sync-message');
      return { type: 'manifest', entries: entries as SyncWireEntry[], more: value.more, through: value.through };
    }
    case 'want': {
      const keys = validateWantKeys(value.keys);
      return { type: 'want', keys };
    }
    case 'record': {
      const record = validateRecordPayload(value.record);
      return { type: 'record', record };
    }
    case 'media-meta': {
      const record = validateRecordPayload(value.record, true);
      if (record.t !== 'media') throw new Error('sync-message');
      const blobSize = Number(value.blobSize);
      const thumbSize = Number(value.thumbSize);
      if (!Number.isSafeInteger(blobSize) || blobSize < 0 || blobSize > SYNC_MAX_MEDIA_BYTES) throw new Error('sync-limit');
      if (!Number.isSafeInteger(thumbSize) || thumbSize < 0 || thumbSize > SYNC_MAX_MEDIA_BYTES) throw new Error('sync-limit');
      const blobType = sanitizeMime(value.blobType);
      const thumbType = sanitizeMime(value.thumbType);
      return { type: 'media-meta', record, blobSize, thumbSize, blobType, thumbType };
    }
    case 'media-chunk': {
      if (value.t !== 'media' || !validRecordId(value.id)) throw new Error('sync-message');
      if (value.part !== 'blob' && value.part !== 'thumb') throw new Error('sync-message');
      if (!Number.isSafeInteger(value.index) || value.index < 0 || value.index > 100_000) throw new Error('sync-message');
      if (typeof value.data !== 'string' || value.data.length > Math.ceil(SYNC_MEDIA_CHUNK_BYTES * 4 / 3) + 8) throw new Error('sync-limit');
      return { type: 'media-chunk', t: 'media', id: value.id, part: value.part, index: value.index, data: value.data };
    }
    case 'media-end':
      if (value.t !== 'media' || !validRecordId(value.id)) throw new Error('sync-message');
      return { type: 'media-end', t: 'media', id: value.id };
    case 'missing': {
      return { type: 'missing', keys: validateWantKeys(value.keys) };
    }
    case 'complete': {
      if (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error('sync-verify');
      if (!Number.isSafeInteger(value.through) || value.through < 0) throw new Error('sync-message');
      const applied = Math.max(0, Math.floor(Number(value.applied) || 0));
      const received = Math.max(0, Math.floor(Number(value.received) || 0));
      const sent = Math.max(0, Math.floor(Number(value.sent) || 0));
      return { type: 'complete', digest: value.digest, through: value.through, applied, received, sent };
    }
    case 'error':
      if (typeof value.code !== 'string' || !/^[a-z0-9-]{3,64}$/.test(value.code)) throw new Error('sync-message');
      return { type: 'error', code: value.code };
    default:
      throw new Error('sync-message');
  }
}

function validateWantKeys(value: any): { t: SyncTable; id: string }[] {
  if (!Array.isArray(value) || value.length > SYNC_MAX_WANT_KEYS) throw new Error('sync-message');
  const seen = new Set<string>();
  const keys: { t: SyncTable; id: string }[] = [];
  for (const item of value) {
    if (!item || !isSyncTable(item.t) || !validRecordId(item.id)) throw new Error('sync-message');
    const key = syncKey(item.t, item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ t: item.t, id: item.id });
  }
  return keys;
}

function validateRecordPayload(value: any, media = false): SyncRecordPayload {
  if (!value || typeof value !== 'object' || !isSyncTable(value.t) || !validRecordId(value.id)) throw new Error('sync-message');
  if (media && value.t !== 'media') throw new Error('sync-message');
  if (typeof value.h !== 'string' || !/^[a-f0-9]{64}$/.test(value.h)) throw new Error('sync-verify');
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error('sync-message');
  if (value.data.id !== value.id) throw new Error('sync-message');
  const blobHash = value.blobHash == null ? undefined : String(value.blobHash);
  const thumbHash = value.thumbHash == null ? undefined : String(value.thumbHash);
  if (blobHash && !/^[a-f0-9]{64}$/.test(blobHash)) throw new Error('sync-verify');
  if (thumbHash && !/^[a-f0-9]{64}$/.test(thumbHash)) throw new Error('sync-verify');
  return { t: value.t, id: value.id, data: value.data, h: value.h, ...(blobHash ? { blobHash } : {}), ...(thumbHash ? { thumbHash } : {}) };
}

export function sanitizePeerName(value: unknown) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'RoamEtch';
}

function sanitizeMime(value: unknown) {
  const text = String(value || '').trim().slice(0, 120);
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(text) ? text : 'application/octet-stream';
}

export function verifyWireRecordHash(record: SyncRecordPayload, hashes?: { blobHash?: string; thumbHash?: string }) {
  return syncRecordHash(record.t, record.data, hashes || { blobHash: record.blobHash, thumbHash: record.thumbHash })
    .then((hash) => hash === record.h ? hash : Promise.reject(new Error('sync-hash')));
}

export function mediaRowFromPayload(payload: SyncRecordPayload, blob: Blob, thumb: Blob) {
  const { _blobHash, _thumbHash, blobSize: _blobSize, blobType: _blobType, thumbSize: _thumbSize, thumbType: _thumbType, ...data } = payload.data;
  return { ...data, blob, thumb };
}

export function validateRemoteRow(table: SyncTable, row: any): string | null {
  if (!row || typeof row !== 'object' || !validRecordId(row.id)) return 'id';
  if (!validRecordId(row.tripId) && table !== 'trips') return 'tripId';
  if (table === 'trips') {
    if (!['recording', 'paused', 'finished'].includes(row.status)) return 'status';
    if (typeof row.name !== 'string' || row.name.length > 500) return 'name';
    if (!Number.isFinite(row.updatedAt) || row.updatedAt < 0) return 'updatedAt';
    if (row.schemaVersion != null && (!Number.isSafeInteger(row.schemaVersion) || row.schemaVersion < 1 || row.schemaVersion > 1)) return 'schemaVersion';
    return null;
  }
  if (table === 'segments') {
    if (!Number.isInteger(row.index) || row.index < 0) return 'index';
    if (!Number.isFinite(row.startTime)) return 'startTime';
    if (row.endTime != null && !Number.isFinite(row.endTime)) return 'endTime';
    return null;
  }
  if (table === 'trackChunks') {
    if (!validRecordId(row.segmentId)) return 'segmentId';
    if (!Number.isInteger(row.seq) || row.seq < 0) return 'seq';
    if (!Array.isArray(row.points) || row.points.length > SYNC_MAX_TRACK_POINTS) return 'points';
    for (const point of row.points) {
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)
        || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180
        || (point.t != null && !Number.isFinite(point.t))) return 'point';
    }
    return null;
  }
  if (table === 'waypoints') {
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lon) || Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180) return 'coordinate';
    if (row.mediaIds != null && (!Array.isArray(row.mediaIds) || row.mediaIds.some((id) => !validRecordId(id)))) return 'mediaIds';
    if (row.time != null && !Number.isFinite(row.time)) return 'time';
    return null;
  }
  if (table === 'media') {
    if (!Number.isFinite(row.width) || !Number.isFinite(row.height) || row.width < 0 || row.height < 0) return 'dimensions';
    if (!Number.isFinite(row.createdAt)) return 'createdAt';
    return null;
  }
  return 'table';
}

export function countWireBytes(message: SyncWireMessage) {
  return JSON.stringify(message).length;
}
