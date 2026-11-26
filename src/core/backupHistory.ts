// Privacy-safe backup metadata lives outside the trip database so resets and
// trip deletion cannot remove it. Only an explicit clear can do that.
import Dexie from 'dexie';
import { get as getSetting } from './settings';

export const BACKUP_HISTORY_DATABASE_NAME = 'localtrace-backup-history';
export const BACKUP_HISTORY_LIMIT = 20;

const BACKUP_KINDS = ['export', 'restore', 'drill'] as const;
const BACKUP_STATUSES = ['exported', 'restored', 'drill-passed', 'failed'] as const;
const BACKUP_SOURCES = ['legacy', 'manual', 'pre-restore', 'drill'] as const;
const MIGRATION_KEY = 'legacy-import-v1';

export type BackupHistoryKind = typeof BACKUP_KINDS[number];
export type BackupHistoryStatus = typeof BACKUP_STATUSES[number];
export type BackupHistorySource = typeof BACKUP_SOURCES[number];

export interface BackupHistoryRecord {
  kind: BackupHistoryKind;
  status: BackupHistoryStatus;
  createdAt: number;
  filename: string;
  bytes: number;
  encrypted: boolean;
  backupFormat: string;
  tripSchema: number;
  appVersion: string;
  trips: number;
  segments: number;
  chunks: number;
  waypoints: number;
  media: number;
  mediaChecked: number;
  mediaFailed: number;
  source: BackupHistorySource;
}

interface StoredBackupHistoryRecord extends BackupHistoryRecord {
  id?: number;
}

interface MigrationMarker {
  key: string;
  value: boolean;
}

const db = new Dexie(BACKUP_HISTORY_DATABASE_NAME);
db.version(1).stores({ records: '++id,createdAt', meta: 'key' });
db.on('versionchange', () => db.close());

const records = db.table<StoredBackupHistoryRecord, number>('records');
const meta = db.table<MigrationMarker, string>('meta');

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isMetadata(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isFilename(value: unknown, source: BackupHistorySource): value is string {
  if (typeof value !== 'string' || value.length > 255) return false;
  // Older versions only persisted a timestamp, so a legacy row has no name.
  if (!value) return source === 'legacy';
  return value.trim().length > 0 && value !== '.' && value !== '..'
    && !/[\\/:\u0000-\u001f\u007f]/.test(value);
}

// Project onto an allowlist: passwords, Blobs, handles, paths and trip contents
// must never reach IndexedDB, even if a caller passes a larger object.
function validatedRecord(value: unknown): BackupHistoryRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!isOneOf(row.kind, BACKUP_KINDS) || !isOneOf(row.status, BACKUP_STATUSES)
    || !isOneOf(row.source, BACKUP_SOURCES) || !isTimestamp(row.createdAt)
    || !isFilename(row.filename, row.source) || !isCount(row.bytes)
    || typeof row.encrypted !== 'boolean' || !isMetadata(row.backupFormat, 80)
    || !isCount(row.tripSchema) || !isMetadata(row.appVersion, 64)
    || !isCount(row.trips) || !isCount(row.segments) || !isCount(row.chunks)
    || !isCount(row.waypoints) || !isCount(row.media)
    || !isCount(row.mediaChecked) || !isCount(row.mediaFailed)) return null;
  return {
    kind: row.kind,
    status: row.status,
    createdAt: row.createdAt,
    filename: row.filename,
    bytes: row.bytes,
    encrypted: row.encrypted,
    backupFormat: row.backupFormat,
    tripSchema: row.tripSchema,
    appVersion: row.appVersion,
    trips: row.trips,
    segments: row.segments,
    chunks: row.chunks,
    waypoints: row.waypoints,
    media: row.media,
    mediaChecked: row.mediaChecked,
    mediaFailed: row.mediaFailed,
    source: row.source
  };
}

function validRecords(rows: StoredBackupHistoryRecord[]): BackupHistoryRecord[] {
  return rows.map((row) => {
    try {
      return { row, record: validatedRecord(row) };
    } catch {
      return { row, record: null };
    }
  }).filter((entry): entry is { row: StoredBackupHistoryRecord; record: BackupHistoryRecord } => !!entry.record)
    .sort((a, b) => b.row.createdAt - a.row.createdAt || (b.row.id || 0) - (a.row.id || 0))
    .slice(0, BACKUP_HISTORY_LIMIT)
    .map((entry) => entry.record);
}

function lastBackupAt(): number {
  const value = Number(getSetting('lastBackupAt'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function legacyRecord(createdAt: number): BackupHistoryRecord {
  return {
    kind: 'export',
    status: 'exported',
    createdAt,
    filename: '',
    bytes: 0,
    encrypted: false,
    backupFormat: 'localtrace-backup',
    tripSchema: 0,
    appVersion: 'unknown',
    trips: 0,
    segments: 0,
    chunks: 0,
    waypoints: 0,
    media: 0,
    mediaChecked: 0,
    mediaFailed: 0,
    source: 'legacy'
  };
}

async function migrateLegacyRecordInTx(): Promise<BackupHistoryRecord[]> {
  const existing = await records.orderBy('createdAt').reverse().toArray();
  if (existing.length) return validRecords(existing);
  if ((await meta.get(MIGRATION_KEY))?.value === true) return [];
  const at = lastBackupAt();
  if (!isTimestamp(at)) return [];
  const legacy = legacyRecord(at);
  await records.add(legacy);
  // Also prevents an explicit clear followed by an empty read from re-importing.
  await meta.put({ key: MIGRATION_KEY, value: true });
  return [legacy];
}

async function migrateLegacyRecord(): Promise<BackupHistoryRecord[]> {
  return db.transaction('rw', [records, meta], migrateLegacyRecordInTx);
}

export async function appendBackupHistory(record: BackupHistoryRecord): Promise<boolean> {
  try {
    const validated = validatedRecord(record);
    if (!validated) return false;
    await db.transaction('rw', [records, meta], async () => {
      await migrateLegacyRecordInTx();
      await records.add(validated);
      const ordered = await records.orderBy('createdAt').reverse().toArray();
      const staleIds = ordered.slice(BACKUP_HISTORY_LIMIT)
        .map((row) => row.id)
        .filter((id): id is number => typeof id === 'number');
      if (staleIds.length) await records.bulkDelete(staleIds);
      await meta.put({ key: MIGRATION_KEY, value: true });
    });
    return true;
  } catch {
    return false;
  }
}

export async function listBackupHistory(): Promise<BackupHistoryRecord[]> {
  try {
    const snapshot = await db.transaction('r', [records, meta], async () => ({
      rows: await records.orderBy('createdAt').reverse().toArray(),
      migrated: (await meta.get(MIGRATION_KEY))?.value === true
    }));
    if (snapshot.rows.length || snapshot.migrated || !lastBackupAt()) return validRecords(snapshot.rows);
    return await migrateLegacyRecord();
  } catch {
    return [];
  }
}

export async function clearBackupHistory(): Promise<boolean> {
  try {
    await db.transaction('rw', [records, meta], async () => {
      await records.clear();
      await meta.put({ key: MIGRATION_KEY, value: true });
    });
    return true;
  } catch {
    return false;
  }
}

export async function getLatestSuccessfulExport(): Promise<BackupHistoryRecord | null> {
  const history = await listBackupHistory();
  return history.find((record) => record.kind === 'export' && record.status === 'exported') || null;
}
