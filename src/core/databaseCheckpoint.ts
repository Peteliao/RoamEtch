import Dexie from 'dexie';
import { diag } from './diag';
import {
  DATABASE_MIGRATIONS, DATABASE_NAME, DATABASE_SCHEMA_VERSION, DATABASE_TABLES, DatabaseMigrationError,
  logicalDatabaseVersion, migrateTripRecord, verifyDatabaseMigration,
  type DatabaseMigrationResult, type DatabasePreflight
} from './migrations';
import { withDatabaseMigrationLock } from './locks';

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_METADATA_STORE = '__migration_checkpoint__';
const CHECKPOINT_ROW_PREFIX = '__migration_rows__:';
const RECOVERY_JOURNAL_VERSION = 1;
const RECOVERY_JOURNAL_STORE = 'migration_recovery';
const DEFAULT_BLOCKED_TIMEOUT_MS = 5_000;
const SCAN_BATCH_SIZE = 128;
const textEncoder = new TextEncoder();
let uniqueSequence = 0;

export interface CheckpointIndexSchema {
  name: string;
  keyPath: string | string[];
  unique: boolean;
  multiEntry: boolean;
}

export interface CheckpointStoreSchema {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: CheckpointIndexSchema[];
}

export interface MigrationCheckpoint {
  databaseName: string;
  sourceName: string;
  sourceVersion: number;
  fromVersion: number;
  createdAt: number;
  verifiedAt: number;
  counts: Record<string, number>;
  fingerprint: string;
  stores: CheckpointStoreSchema[];
}

interface CheckpointMetadata extends MigrationCheckpoint {
  formatVersion: number;
  verified: boolean;
}

export interface DatabaseCheckpointOptions {
  sourceName?: string;
  blockedTimeoutMs?: number;
  deleteTimeoutMs?: number;
  now?: () => number;
  verify?: (database: any, preflight: DatabasePreflight) => Promise<DatabaseMigrationResult>;
}

export interface MigrationRecoveryState {
  formatVersion: number;
  sourceName: string;
  checkpointName: string;
  recoveryName: string;
  fromVersion: number;
  toVersion: number;
  phase: 'prepared' | 'restoring' | 'verified';
  updatedAt: number;
}

interface FingerprintOptions {
  nameForStore?: (name: string) => string;
  transform?: (table: string, row: any) => any;
}

function checkpointPrefix(sourceName = DATABASE_NAME) {
  return `${sourceName}:migration-checkpoint:`;
}

function recoveryPrefix(sourceName = DATABASE_NAME) {
  return `${sourceName}:migration-recovery:`;
}

function recoveryJournalName(sourceName = DATABASE_NAME) {
  return `${sourceName}:migration-recovery-journal`;
}

function rowStoreName(name: string) {
  return CHECKPOINT_ROW_PREFIX + name;
}

function uniqueDatabaseName(prefix: string, now: number) {
  uniqueSequence = (uniqueSequence + 1) % Number.MAX_SAFE_INTEGER;
  const random = globalThis.crypto?.randomUUID?.()
    || `${Math.random().toString(36).slice(2)}-${uniqueSequence.toString(36)}`;
  return `${prefix}${now.toString(36)}-${random}`;
}

function migrationError(code: string, message: string, cause?: unknown) {
  const error = new DatabaseMigrationError(code, message);
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isQuotaError(error: any) {
  return error?.name === 'QuotaExceededError'
    || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22 || error?.code === 1014;
}

function checkpointFailure(error: unknown): DatabaseMigrationError {
  if (error instanceof DatabaseMigrationError && error.code.startsWith('migration-checkpoint-')) return error;
  if (isQuotaError(error)) {
    return migrationError(
      'migration-checkpoint-capacity',
      'Cannot create a verified migration recovery point because browser storage is full or quota is blocked. Free storage or close other tabs, then retry; the database was not upgraded.',
      error
    );
  }
  return migrationError(
    'migration-checkpoint-failed',
    `Could not create a verified migration recovery point. The database was not upgraded. ${errorMessage(error)}`,
    error
  );
}

function blockedMessage(action: string, databaseName: string) {
  return `${action} ${databaseName} because another tab or browser extension is blocking IndexedDB. Close other LocalTrace tabs or blocking software, then retry.`;
}

function openRawDatabase(
  name: string,
  blockedCode: string,
  blockedTimeoutMs: number,
  create?: (database: IDBDatabase, transaction: IDBTransaction) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    let upgradeFromVersion = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    try { request = indexedDB.open(name, create ? CHECKPOINT_VERSION : undefined); }
    catch (error) { fail(error); return; }
    timer = setTimeout(() => fail(new DatabaseMigrationError(
      blockedCode, blockedMessage('Cannot open', name)
    )), Math.max(1, blockedTimeoutMs));
    request.onupgradeneeded = (event) => {
      upgradeFromVersion = event.oldVersion;
      if (!create) {
        request.transaction?.abort();
        return;
      }
      try {
        if (request.transaction) create(request.result, request.transaction);
      } catch (error) {
        request.transaction?.abort();
        fail(error);
      }
    };
    request.onblocked = () => fail(new DatabaseMigrationError(
      blockedCode, blockedMessage('Cannot open', name)
    ));
    request.onerror = () => {
      if (request.error?.name === 'AbortError' && !create) {
        fail(new DatabaseMigrationError(
          upgradeFromVersion === 0 ? 'migration-checkpoint-absent' : 'migration-checkpoint-unavailable',
          upgradeFromVersion === 0 ? `Recovery checkpoint not found: ${name}` : `Recovery checkpoint schema is unsupported: ${name}`
        ));
      } else fail(request.error || new Error('IndexedDB open failed'));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function deleteRawDatabase(name: string, code: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    try { request = indexedDB.deleteDatabase(name); }
    catch (error) { fail(error); return; }
    timer = setTimeout(() => fail(new DatabaseMigrationError(
      code, blockedMessage('Cannot delete', name)
    )), Math.max(1, timeoutMs));
    request.onblocked = () => fail(new DatabaseMigrationError(
      code, blockedMessage('Cannot delete', name)
    ));
    request.onerror = () => fail(request.error || new Error('IndexedDB deletion failed'));
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve();
    };
  });
}

function normalizeKeyPath(keyPath: string | string[] | null): string | string[] | null {
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

function describeStore(database: IDBDatabase, name: string): CheckpointStoreSchema {
  const store = database.transaction(name, 'readonly').objectStore(name);
  return {
    name,
    keyPath: normalizeKeyPath(store.keyPath),
    autoIncrement: store.autoIncrement,
    indexes: [...store.indexNames].sort().map((indexName) => {
      const index = store.index(indexName);
      return {
        name: indexName,
        keyPath: normalizeKeyPath(index.keyPath) as string | string[],
        unique: index.unique,
        multiEntry: index.multiEntry
      };
    })
  };
}

function describeSchema(database: IDBDatabase): CheckpointStoreSchema[] {
  return [...database.objectStoreNames].sort().map((name) => describeStore(database, name));
}

function createCheckpointStores(database: IDBDatabase, transaction: IDBTransaction, stores: CheckpointStoreSchema[]) {
  database.createObjectStore(CHECKPOINT_METADATA_STORE, { keyPath: 'databaseName' });
  for (const schema of stores) {
    const store = database.createObjectStore(rowStoreName(schema.name), {
      keyPath: normalizeKeyPath(schema.keyPath), autoIncrement: schema.autoIncrement
    });
    for (const index of schema.indexes) {
      store.createIndex(index.name, normalizeKeyPath(index.keyPath), {
        unique: index.unique, multiEntry: index.multiEntry
      });
    }
  }
  void transaction;
}

async function writeRowBatch(
  target: IDBDatabase,
  table: string,
  targetName: string,
  rows: { key: IDBValidKey; value: any }[],
  transform?: (table: string, row: any) => any
): Promise<void> {
  if (!rows.length) return;
  const transaction = target.transaction(targetName, 'readwrite');
  const store = transaction.objectStore(targetName);
  for (const row of rows) {
    const value = transform ? transform(table, row.value) : row.value;
    if (store.keyPath === null) store.put(value, row.key);
    else store.put(value);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error(`Checkpoint write aborted: ${table}`));
    transaction.onerror = () => reject(transaction.error || new Error(`Checkpoint write failed: ${table}`));
  });
}

async function copyRows(
  source: IDBDatabase,
  sourceNames: string[],
  target: IDBDatabase,
  nameForStore: (name: string) => string,
  sourceNameForStore: (name: string) => string = (name) => name,
  transform?: (table: string, row: any) => any
): Promise<void> {
  // Cross-database transactions cannot stay atomically active together. Bounded batches avoid both
  // transaction-inactive writes and retaining an entire trip/media database in JavaScript memory.
  for (const table of sourceNames) {
    const targetName = nameForStore(table);
    if (!target.objectStoreNames.contains(targetName)) {
      throw new Error(`Recovery target is missing store ${targetName}; available stores: ${[...target.objectStoreNames].join(', ')}`);
    }
    const sourceName = sourceNameForStore(table);
    await scanRows(source, sourceName, (rows) => writeRowBatch(
      target, table, targetName, rows, transform
    ));
  }
}

async function scanRows(
  database: IDBDatabase,
  storeName: string,
  visit: (rows: { key: IDBValidKey; value: any }[]) => Promise<void>
): Promise<void> {
  let after: IDBValidKey | undefined;
  while (true) {
    const result = await new Promise<{ rows: { key: IDBValidKey; value: any }[]; done: boolean }>((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.openCursor(after === undefined ? undefined : IDBKeyRange.lowerBound(after, true));
      const rows: { key: IDBValidKey; value: any }[] = [];
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      transaction.onabort = () => fail(transaction.error || new Error(`Cannot scan store: ${storeName}`));
      transaction.onerror = () => fail(transaction.error || new Error(`Cannot scan store: ${storeName}`));
      request.onerror = () => fail(request.error || new Error(`Cannot scan store: ${storeName}`));
      request.onsuccess = () => {
        if (settled) return;
        try {
          const cursor = request.result;
          if (!cursor) {
            settled = true;
            resolve({ rows, done: true });
            return;
          }
          rows.push({ key: cursor.primaryKey, value: cursor.value });
          if (rows.length >= SCAN_BATCH_SIZE) {
            settled = true;
            resolve({ rows, done: false });
          } else cursor.continue();
        } catch (error) {
          fail(error);
        }
      };
    });
    await visit(result.rows);
    if (result.done) return;
    after = result.rows[result.rows.length - 1].key;
  }
}

// Small streaming SHA-256 implementation: hashing must not retain a second copy of large media Blobs.
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

class StreamingSha256 {
  private state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  private block = new Uint8Array(64);
  private blockLength = 0;
  private byteLength = 0;

  update(bytes: Uint8Array) {
    this.byteLength += bytes.byteLength;
    let offset = 0;
    if (this.blockLength) {
      const take = Math.min(64 - this.blockLength, bytes.byteLength);
      this.block.set(bytes.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.compress(this.block);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= bytes.byteLength) {
      this.compress(bytes.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < bytes.byteLength) {
      this.block.set(bytes.subarray(offset), this.blockLength);
      this.blockLength += bytes.byteLength - offset;
    }
  }

  digest(): Uint8Array {
    const bitLength = this.byteLength * 8;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x1_0000_0000));
    view.setUint32(60, bitLength >>> 0);
    this.compress(this.block);
    const result = new Uint8Array(32);
    const output = new DataView(result.buffer);
    this.state.forEach((word, index) => output.setUint32(index * 4, word));
    return result;
  }

  private compress(block: Uint8Array) {
    const words = new Uint32Array(64);
    const input = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index++) words[index] = input.getUint32(index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    const rotate = (value: number, count: number) => (value >>> count) | (value << (32 - count));
    for (let index = 0; index < 64; index++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

function hashBytes(hash: StreamingSha256, bytes: Uint8Array) {
  hash.update(Uint8Array.of(bytes.byteLength >>> 24, (bytes.byteLength >>> 16) & 255, (bytes.byteLength >>> 8) & 255, bytes.byteLength & 255));
  hash.update(bytes);
}

function hashString(hash: StreamingSha256, value: string) {
  hashBytes(hash, textEncoder.encode(value));
}

function hashNumber(hash: StreamingSha256, value: number) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value);
  hash.update(bytes);
}

function compareBytes(a: Uint8Array, b: Uint8Array) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

async function valueDigest(value: any, ancestors = new WeakSet<object>()): Promise<Uint8Array> {
  const hash = new StreamingSha256();
  await writeCanonical(hash, value, ancestors);
  return hash.digest();
}

async function writeCanonical(hash: StreamingSha256, value: any, ancestors = new WeakSet<object>()) {
  if (value === undefined) { hash.update(Uint8Array.of(117)); return; }
  if (value === null) { hash.update(Uint8Array.of(110)); return; }
  if (typeof value === 'boolean') { hash.update(Uint8Array.of(value ? 49 : 48)); return; }
  if (typeof value === 'number') { hash.update(Uint8Array.of(100)); hashNumber(hash, value); return; }
  if (typeof value === 'bigint') { hash.update(Uint8Array.of(105)); hashString(hash, String(value)); return; }
  if (typeof value === 'string') { hash.update(Uint8Array.of(115)); hashString(hash, value); return; }
  if (typeof value !== 'object') throw new Error(`Unsupported checkpoint value: ${typeof value}`);
  if (ancestors.has(value)) throw new Error('Cyclic checkpoint values are not supported');
  ancestors.add(value);
  try {
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      const isFile = typeof File !== 'undefined' && value instanceof File;
      hash.update(Uint8Array.of(isFile ? 70 : 66));
      hashString(hash, value.type);
      hashNumber(hash, value.size);
      if (isFile) {
        hashString(hash, (value as File).name);
        hashNumber(hash, (value as File).lastModified);
      }
      if (typeof value.stream === 'function') {
        const reader = value.stream().getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          hash.update(chunk);
        }
      } else hash.update(new Uint8Array(await value.arrayBuffer()));
      return;
    }
    if (value instanceof Date) {
      hash.update(Uint8Array.of(68)); hashNumber(hash, value.getTime()); return;
    }
    if (value instanceof RegExp) {
      hash.update(Uint8Array.of(114)); hashString(hash, value.source); hashString(hash, value.flags); return;
    }
    if (value instanceof ArrayBuffer) {
      hash.update(Uint8Array.of(65)); hashBytes(hash, new Uint8Array(value)); return;
    }
    if (ArrayBuffer.isView(value)) {
      hash.update(Uint8Array.of(86)); hashString(hash, value.constructor?.name || 'DataView');
      hashBytes(hash, new Uint8Array(value.buffer, value.byteOffset, value.byteLength)); return;
    }
    if (Array.isArray(value)) {
      hash.update(Uint8Array.of(97)); hashNumber(hash, value.length);
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) hash.update(Uint8Array.of(104));
        else await writeCanonical(hash, value[index], ancestors);
      }
      return;
    }
    if (value instanceof Map) {
      hash.update(Uint8Array.of(109)); hashNumber(hash, value.size);
      const entries = await Promise.all([...value].map(async ([key, entry]) => ({
        key: await valueDigest(key, ancestors), value: await valueDigest(entry, ancestors)
      })));
      entries.sort((a, b) => compareBytes(a.key, b.key) || compareBytes(a.value, b.value));
      for (const entry of entries) {
        hash.update(entry.key); hash.update(entry.value);
      }
      return;
    }
    if (value instanceof Set) {
      hash.update(Uint8Array.of(83)); hashNumber(hash, value.size);
      const entries = await Promise.all([...value].map((entry) => valueDigest(entry, ancestors)));
      entries.sort(compareBytes);
      for (const entry of entries) hash.update(entry);
      return;
    }
    hash.update(Uint8Array.of(111));
    const keys = Object.keys(value).sort();
    hashNumber(hash, keys.length);
    for (const key of keys) {
      hashString(hash, key);
      await writeCanonical(hash, value[key], ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

async function fingerprintDatabase(
  database: IDBDatabase,
  metadata: Pick<MigrationCheckpoint, 'sourceName' | 'sourceVersion' | 'stores'>,
  options: FingerprintOptions = {}
): Promise<{ fingerprint: string; counts: Record<string, number> }> {
  const hash = new StreamingSha256();
  await writeCanonical(hash, {
    format: 'localtrace-migration-content-v1',
    sourceName: metadata.sourceName,
    sourceVersion: metadata.sourceVersion,
    stores: metadata.stores
  });
  const counts: Record<string, number> = {};
  for (const schema of metadata.stores) {
    let count = 0;
    await scanRows(database, options.nameForStore?.(schema.name) || schema.name, async (rows) => {
      for (const row of rows) {
        await writeCanonical(hash, schema.name);
        await writeCanonical(hash, row.key);
        await writeCanonical(hash, options.transform ? options.transform(schema.name, row.value) : row.value);
        count++;
      }
    });
    counts[schema.name] = count;
    await writeCanonical(hash, count);
  }
  const digest = hash.digest();
  return {
    counts,
    fingerprint: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  };
}

async function writeMetadata(database: IDBDatabase, metadata: CheckpointMetadata) {
  const transaction = database.transaction(CHECKPOINT_METADATA_STORE, 'readwrite');
  const request = transaction.objectStore(CHECKPOINT_METADATA_STORE).put(metadata);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('Checkpoint metadata write aborted'));
    transaction.onerror = () => reject(transaction.error || request.error || new Error('Checkpoint metadata write failed'));
  });
}

async function readMetadata(database: IDBDatabase): Promise<CheckpointMetadata | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHECKPOINT_METADATA_STORE, 'readonly');
    const request = transaction.objectStore(CHECKPOINT_METADATA_STORE).get(database.name);
    request.onsuccess = () => resolve(request.result || undefined);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function validateRecoveryState(state: any, sourceName: string): asserts state is MigrationRecoveryState {
  if (!state || state.formatVersion !== RECOVERY_JOURNAL_VERSION || state.sourceName !== sourceName
    || typeof state.checkpointName !== 'string' || !state.checkpointName.startsWith(checkpointPrefix(sourceName))
    || typeof state.recoveryName !== 'string' || !state.recoveryName.startsWith(recoveryPrefix(sourceName))
    || !Number.isSafeInteger(state.fromVersion) || state.fromVersion < 0
    || !Number.isSafeInteger(state.toVersion) || state.toVersion < state.fromVersion
    || !['prepared', 'restoring', 'verified'].includes(state.phase)
    || !Number.isFinite(state.updatedAt)) {
    throw migrationError('migration-rollback-journal-invalid', 'The durable migration rollback journal is invalid. Keep the database closed and retain all recovery databases.');
  }
}

async function openRecoveryJournal(sourceName: string, options: DatabaseCheckpointOptions, create: boolean) {
  const name = recoveryJournalName(sourceName);
  if (!create && typeof indexedDB.databases === 'function') {
    const entries = await indexedDB.databases();
    if (!entries.some((entry) => entry.name === name)) return undefined;
  }
  try {
    return await openRawDatabase(
      name, 'migration-rollback-journal-blocked', options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS,
      create ? (database, transaction) => {
        database.createObjectStore(RECOVERY_JOURNAL_STORE, { keyPath: 'sourceName' });
        void transaction;
      } : undefined
    );
  } catch (error) {
    if (!create && error instanceof DatabaseMigrationError && error.code === 'migration-checkpoint-absent') return undefined;
    throw error;
  }
}

export async function readMigrationRecoveryState(
  sourceName = DATABASE_NAME,
  options: DatabaseCheckpointOptions = {}
): Promise<MigrationRecoveryState | undefined> {
  const database = await openRecoveryJournal(sourceName, options, false);
  if (!database) return undefined;
  try {
    if (database.version !== RECOVERY_JOURNAL_VERSION) {
      throw migrationError('migration-rollback-journal-invalid', 'The durable migration rollback journal has an unsupported schema.');
    }
    const state = await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction(RECOVERY_JOURNAL_STORE, 'readonly');
      const request = transaction.objectStore(RECOVERY_JOURNAL_STORE).get(sourceName);
      request.onsuccess = () => resolve(request.result || undefined);
      request.onerror = () => reject(request.error);
      transaction.onabort = () => reject(transaction.error);
    });
    if (!state) return undefined;
    validateRecoveryState(state, sourceName);
    return state;
  } finally {
    database.close();
  }
}

async function writeMigrationRecoveryState(state: MigrationRecoveryState, options: DatabaseCheckpointOptions) {
  const database = await openRecoveryJournal(state.sourceName, options, true);
  try {
    const transaction = database.transaction(RECOVERY_JOURNAL_STORE, 'readwrite');
    transaction.objectStore(RECOVERY_JOURNAL_STORE).put(state);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Recovery journal write aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Recovery journal write failed'));
    });
  } finally {
    database.close();
  }
}

async function clearMigrationRecoveryState(sourceName: string, options: DatabaseCheckpointOptions) {
  const database = await openRecoveryJournal(sourceName, options, false);
  if (!database) return;
  try {
    const transaction = database.transaction(RECOVERY_JOURNAL_STORE, 'readwrite');
    transaction.objectStore(RECOVERY_JOURNAL_STORE).delete(sourceName);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Recovery journal cleanup aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Recovery journal cleanup failed'));
    });
  } finally {
    database.close();
  }
}

function checkpointMismatch(message: string): DatabaseMigrationError {
  return migrationError(
    'migration-checkpoint-verification-failed',
    `Migration recovery checkpoint verification failed: ${message} Keep the checkpoint and do not upgrade the source database.`
  );
}

function validateMetadata(metadata: any): asserts metadata is CheckpointMetadata {
  if (!metadata || metadata.formatVersion !== CHECKPOINT_VERSION || metadata.verified !== true
    || typeof metadata.databaseName !== 'string' || typeof metadata.sourceName !== 'string'
    || !Number.isSafeInteger(metadata.sourceVersion) || metadata.sourceVersion < 0
    || !Number.isSafeInteger(metadata.fromVersion) || metadata.fromVersion < 0
    || !Number.isFinite(metadata.createdAt) || !Number.isFinite(metadata.verifiedAt)
    || typeof metadata.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.fingerprint)
    || !Array.isArray(metadata.stores) || !metadata.counts || typeof metadata.counts !== 'object') {
    throw checkpointMismatch('missing or invalid metadata');
  }
  const validKeyPath = (value: any, allowNull: boolean) => value === null
    ? allowNull
    : (typeof value === 'string' && value.length > 0)
      || (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string' && part.length > 0));
  const names = new Set<string>();
  for (const store of metadata.stores) {
    if (!store || typeof store.name !== 'string' || !store.name || names.has(store.name)
      || !validKeyPath(store.keyPath, true)
      || typeof store.autoIncrement !== 'boolean' || !Array.isArray(store.indexes)
      || !Number.isSafeInteger(metadata.counts[store.name]) || metadata.counts[store.name] < 0) {
      throw checkpointMismatch('invalid store schema or row count');
    }
    const indexNames = new Set<string>();
    for (const index of store.indexes) {
      if (!index || typeof index.name !== 'string' || !index.name || indexNames.has(index.name)
        || !validKeyPath(index.keyPath, false) || typeof index.unique !== 'boolean'
        || typeof index.multiEntry !== 'boolean') {
        throw checkpointMismatch(`invalid index schema for ${store.name}`);
      }
      indexNames.add(index.name);
    }
    names.add(store.name);
  }
  if (JSON.stringify(Object.keys(metadata.counts).sort()) !== JSON.stringify([...names].sort())) {
    throw checkpointMismatch('row counts do not match the store list');
  }
}

async function verifyOpenCheckpoint(
  database: IDBDatabase,
  expectedSourceName?: string
): Promise<CheckpointMetadata> {
  if (database.version !== CHECKPOINT_VERSION) throw checkpointMismatch('unexpected checkpoint schema version');
  const metadata = await readMetadata(database);
  validateMetadata(metadata);
  if (metadata.databaseName !== database.name) throw checkpointMismatch('checkpoint identity does not match its database');
  if (expectedSourceName && metadata.sourceName !== expectedSourceName) {
    throw checkpointMismatch('checkpoint belongs to a different source database');
  }
  const actualStores = [...database.objectStoreNames].filter((name) => name !== CHECKPOINT_METADATA_STORE).sort();
  const expectedStores = metadata.stores.map((store) => rowStoreName(store.name)).sort();
  if (JSON.stringify(actualStores) !== JSON.stringify(expectedStores)) {
    throw checkpointMismatch(`checkpoint object stores do not match its manifest (expected ${expectedStores.join(', ')}; found ${actualStores.join(', ')})`);
  }
  for (const schema of metadata.stores) {
    const actual = describeStore(database, rowStoreName(schema.name));
    if (JSON.stringify({ ...actual, name: '' }) !== JSON.stringify({ ...schema, name: '' })) {
      throw checkpointMismatch(`checkpoint schema differs for ${schema.name}`);
    }
  }
  const content = await fingerprintDatabase(database, metadata, { nameForStore: rowStoreName });
  if (JSON.stringify(content.counts) !== JSON.stringify(metadata.counts)
    || content.fingerprint !== metadata.fingerprint) {
    throw checkpointMismatch('row contents or counts differ from the recorded fingerprint');
  }
  return metadata;
}

async function openVerifiedCheckpoint(name: string, options: DatabaseCheckpointOptions = {}) {
  if (!name.startsWith(checkpointPrefix(options.sourceName || DATABASE_NAME))) {
    throw checkpointMismatch('unexpected checkpoint database name');
  }
  const database = await openRawDatabase(
    name, 'migration-checkpoint-blocked', options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS
  );
  try {
    const metadata = await verifyOpenCheckpoint(database, options.sourceName || DATABASE_NAME);
    return { database, metadata };
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function readMigrationCheckpoint(name: string, options: DatabaseCheckpointOptions = {}): Promise<MigrationCheckpoint> {
  const { database, metadata } = await openVerifiedCheckpoint(name, options);
  database.close();
  return metadata;
}

async function pruneOldCheckpoints(sourceName: string, latest: MigrationCheckpoint, options: DatabaseCheckpointOptions) {
  if (typeof indexedDB.databases !== 'function') return;
  let entries: { name?: string }[];
  try { entries = await indexedDB.databases(); }
  catch { return; }
  const prefix = checkpointPrefix(sourceName);
  const candidates: { name: string; createdAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.name?.startsWith(prefix) || entry.name === latest.databaseName) continue;
    let database: IDBDatabase | undefined;
    try {
      database = await openRawDatabase(entry.name, 'migration-checkpoint-blocked', options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
      const metadata = await readMetadata(database);
      if (metadata?.verified && metadata.createdAt <= latest.createdAt) candidates.push({ name: entry.name, createdAt: metadata.createdAt });
    } catch {
      // An unverifiable or concurrently created checkpoint is never removed.
    } finally {
      database?.close();
    }
  }
  candidates.sort((a, b) => a.createdAt - b.createdAt);
  for (const candidate of candidates) {
    try {
      await deleteRawDatabase(candidate.name, 'migration-checkpoint-blocked', options.deleteTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
    } catch (error) {
      diag('store', 'database migration checkpoint cleanup blocked', {
        checkpoint: candidate.name, code: (error as any)?.code || 'migration-checkpoint-cleanup-failed'
      });
    }
  }
}

export async function createMigrationCheckpoint(
  preflight: DatabasePreflight,
  options: DatabaseCheckpointOptions = {}
): Promise<MigrationCheckpoint> {
  if (!preflight.needsUpgrade || preflight.skipped) {
    throw new DatabaseMigrationError('migration-checkpoint-not-required', 'A migration checkpoint is only required before an actual schema upgrade.');
  }
  const sourceName = options.sourceName || DATABASE_NAME;
  const now = options.now || (() => Date.now());
  const createdAt = now();
  const databaseName = uniqueDatabaseName(checkpointPrefix(sourceName), createdAt);
  let source: IDBDatabase | undefined;
  let checkpoint: IDBDatabase | undefined;
  diag('store', 'database migration checkpoint started', {
    source: sourceName, fromVersion: preflight.fromVersion, toVersion: preflight.toVersion, checkpoint: databaseName
  });
  try {
    let sourceExists = preflight.fromVersion > 0;
    if (!sourceExists) {
      if (typeof indexedDB.databases !== 'function' || preflight.stores.length) {
        throw checkpointMismatch('cannot establish whether the source database exists');
      }
      const entries = await indexedDB.databases();
      sourceExists = entries.some((entry) => entry.name === sourceName);
    }
    if (sourceExists) {
      source = await openRawDatabase(sourceName, 'migration-checkpoint-blocked', options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
      if (logicalDatabaseVersion(source.version) !== preflight.fromVersion) {
        throw checkpointMismatch('source schema changed after preflight');
      }
    }
    const stores = source ? describeSchema(source) : [];
    checkpoint = await openRawDatabase(
      databaseName, 'migration-checkpoint-blocked', options.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS,
      (database, transaction) => createCheckpointStores(database, transaction, stores)
    );
    if (source) await copyRows(source, stores.map((store) => store.name), checkpoint, rowStoreName);
    const manifest = { sourceName, sourceVersion: source?.version ?? 0, stores };
    const sourceContent = await fingerprintDatabase(source || checkpoint, manifest);
    const checkpointContent = await fingerprintDatabase(checkpoint, manifest, { nameForStore: rowStoreName });
    if (sourceContent.fingerprint !== checkpointContent.fingerprint
      || JSON.stringify(sourceContent.counts) !== JSON.stringify(checkpointContent.counts)) {
      throw checkpointMismatch('copied rows differ from the source database');
    }
    const metadata: CheckpointMetadata = {
      formatVersion: CHECKPOINT_VERSION,
      verified: true,
      databaseName,
      sourceName,
      sourceVersion: source?.version ?? 0,
      fromVersion: preflight.fromVersion,
      createdAt,
      verifiedAt: now(),
      counts: sourceContent.counts,
      fingerprint: sourceContent.fingerprint,
      stores
    };
    await writeMetadata(checkpoint, metadata);
    checkpoint.close();
    checkpoint = undefined;
    const verified = await readMigrationCheckpoint(databaseName, { ...options, sourceName });
    diag('store', 'database migration checkpoint verified', {
      source: sourceName, fromVersion: verified.fromVersion, toVersion: preflight.toVersion,
      checkpoint: databaseName, counts: verified.counts, fingerprint: verified.fingerprint
    });
    await pruneOldCheckpoints(sourceName, verified, options);
    return verified;
  } catch (error) {
    const failure = checkpointFailure(error);
    diag('store', 'database migration checkpoint failed', {
      source: sourceName, checkpoint: databaseName, code: failure.code
    });
    throw failure;
  } finally {
    source?.close();
    checkpoint?.close();
  }
}

function extraDexieSchema(schema: CheckpointStoreSchema) {
  const keyPath = Array.isArray(schema.keyPath) ? schema.keyPath.join('+') : schema.keyPath;
  let primary = keyPath || (schema.autoIncrement ? '++' : '');
  if (keyPath && schema.autoIncrement) primary = `++${primary}`;
  const indexes = schema.indexes.map((index) => {
    const path = Array.isArray(index.keyPath) ? index.keyPath.join('+') : index.keyPath;
    return `${index.multiEntry ? '*' : ''}${index.unique ? '&' : ''}[${path}]`;
  });
  return [primary, ...indexes].join(',');
}

function createRecoveryDatabase(name: string, checkpoint: MigrationCheckpoint) {
  const database = new Dexie(name) as any;
  const knownStores = new Set(DATABASE_MIGRATIONS.flatMap((migration) => Object.keys(migration.stores)));
  const extraStores = Object.fromEntries(checkpoint.stores
    .filter((store) => !knownStores.has(store.name))
    .map((store) => [store.name, extraDexieSchema(store)]));
  for (const migration of DATABASE_MIGRATIONS) {
    const stores = migration.version === 1 ? { ...migration.stores, ...extraStores } : migration.stores;
    const version = database.version(migration.version).stores(stores);
    if (migration.upgrade) version.upgrade(migration.upgrade);
  }
  database.on('versionchange', () => database.close());
  return database;
}

function migratedCheckpointRow(table: string, row: any) {
  if (table === 'trips') migrateTripRecord(row);
  return row;
}

async function verifyRecoveredRows(
  checkpoint: IDBDatabase,
  recovered: IDBDatabase,
  metadata: CheckpointMetadata
) {
  const expected = await fingerprintDatabase(checkpoint, metadata, {
    nameForStore: rowStoreName, transform: migratedCheckpointRow
  });
  const actual = await fingerprintDatabase(recovered, metadata, { transform: migratedCheckpointRow });
  if (expected.fingerprint !== actual.fingerprint || JSON.stringify(expected.counts) !== JSON.stringify(actual.counts)) {
    throw migrationError('migration-rollback-verification-failed', 'Recovered database rows do not match the verified checkpoint.');
  }
}

async function rollbackDatabaseMigrationUnlocked(
  database: any,
  preflight: DatabasePreflight,
  checkpointReference: MigrationCheckpoint,
  options: DatabaseCheckpointOptions = {}
): Promise<DatabaseMigrationResult> {
  const sourceName = database.name || checkpointReference.sourceName;
  const recoveryName = uniqueDatabaseName(recoveryPrefix(sourceName), options.now?.() || Date.now());
  let checkpoint: IDBDatabase | undefined;
  let recovered: any;
  let recoveredRaw: IDBDatabase | undefined;
  let recreatedMain: any;
  let succeeded = false;
  diag('store', 'database migration rollback started', {
    source: sourceName, checkpoint: checkpointReference.databaseName, recovery: recoveryName
  });
  try {
    database.close({ disableAutoOpen: true });
    const verified = await openVerifiedCheckpoint(checkpointReference.databaseName, { ...options, sourceName });
    checkpoint = verified.database;
    const metadata = verified.metadata;
    if (logicalDatabaseVersion(metadata.sourceVersion) !== preflight.fromVersion) {
      throw migrationError('migration-rollback-checkpoint-invalid', 'Recovery checkpoint schema does not match the failed migration.');
    }

    recovered = createRecoveryDatabase(recoveryName, metadata);
    await recovered.open();
    recoveredRaw = recovered.backendDB();
    const knownStores = new Set(DATABASE_MIGRATIONS.flatMap((migration) => Object.keys(migration.stores)));
    const expectedExtraStores = metadata.stores.map((store) => store.name).filter((name) => !knownStores.has(name));
    const missingExtraStores = expectedExtraStores.filter((name) => !recoveredRaw.objectStoreNames.contains(name));
    if (missingExtraStores.length) {
      throw new Error(`Recovery schema omitted source stores: ${missingExtraStores.join(', ')}`);
    }
    await copyRows(
      checkpoint, metadata.stores.map((store) => store.name), recoveredRaw,
      (name) => name, rowStoreName, migratedCheckpointRow
    );
    await verifyRecoveredRows(checkpoint, recoveredRaw, metadata);
    await (options.verify || verifyDatabaseMigration)(recovered, preflight);
    diag('store', 'database migration recovery prepared', {
      source: sourceName, recovery: recoveryName, checkpoint: metadata.databaseName, verified: true
    });

    // The failed main DB is not touched until an independent current-schema DB is fully verified.
    const recoveryState: MigrationRecoveryState = {
      formatVersion: RECOVERY_JOURNAL_VERSION, sourceName, checkpointName: metadata.databaseName,
      recoveryName, fromVersion: preflight.fromVersion, toVersion: preflight.toVersion,
      phase: 'prepared', updatedAt: options.now?.() || Date.now()
    };
    await writeMigrationRecoveryState(recoveryState, options);
    await deleteRawDatabase(sourceName, 'migration-rollback-blocked', options.deleteTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
    await writeMigrationRecoveryState({ ...recoveryState, phase: 'restoring', updatedAt: options.now?.() || Date.now() }, options);
    recreatedMain = createRecoveryDatabase(sourceName, metadata);
    await recreatedMain.open();
    const mainRaw: IDBDatabase = recreatedMain.backendDB();
    await copyRows(recoveredRaw, metadata.stores.map((store) => store.name), mainRaw, (name) => name);
    await verifyRecoveredRows(checkpoint, mainRaw, metadata);
    await writeMigrationRecoveryState({ ...recoveryState, phase: 'verified', updatedAt: options.now?.() || Date.now() }, options);
    recreatedMain.close({ disableAutoOpen: true });
    recreatedMain = undefined;

    await database.open();
    await verifyRecoveredRows(checkpoint, database.backendDB(), metadata);
    const result = await (options.verify || verifyDatabaseMigration)(database, preflight);
    await clearMigrationRecoveryState(sourceName, options);
    succeeded = true;
    diag('store', 'database migration rollback verified', {
      source: sourceName, recovery: recoveryName, checkpoint: metadata.databaseName,
      fromVersion: result.fromVersion, toVersion: result.toVersion, verified: result.verified
    });
    return result;
  } catch (error) {
    const code = error instanceof DatabaseMigrationError && error.code === 'migration-rollback-blocked'
      ? error.code
      : error instanceof DatabaseMigrationError && error.code === 'migration-checkpoint-verification-failed'
        ? 'migration-rollback-checkpoint-invalid'
        : 'migration-rollback-failed';
    const failure = migrationError(
      code,
      code === 'migration-rollback-blocked'
        ? `${errorMessage(error)} The verified recovery database and checkpoint have been retained.`
        : `Automatic migration rollback could not be verified. The checkpoint${recovered ? ` and temporary recovery database ${recoveryName}` : ''} have been retained. ${errorMessage(error)}`,
      error
    );
    diag('store', 'database migration rollback failed', {
      source: sourceName, checkpoint: checkpointReference.databaseName, recovery: recovered ? recoveryName : null,
      code: failure.code
    });
    throw failure;
  } finally {
    checkpoint?.close();
    recreatedMain?.close({ disableAutoOpen: true });
    if (recovered) {
      if (succeeded) {
        recovered.close({ disableAutoOpen: true });
        try {
          await deleteRawDatabase(recoveryName, 'migration-rollback-blocked', options.deleteTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
        } catch (error) {
          // Main is already verified; a blocked optional cleanup must not destroy the extra recovery copy.
          diag('store', 'database migration recovery cleanup blocked', {
            recovery: recoveryName, code: (error as any)?.code || 'migration-rollback-cleanup-failed'
          });
        }
      } else recovered.close({ disableAutoOpen: true });
    }
    void recoveredRaw;
  }
}

export function rollbackDatabaseMigration(
  database: any,
  preflight: DatabasePreflight,
  checkpointReference: MigrationCheckpoint,
  options: DatabaseCheckpointOptions = {}
): Promise<DatabaseMigrationResult> {
  return withDatabaseMigrationLock(() => rollbackDatabaseMigrationUnlocked(database, preflight, checkpointReference, options));
}

async function resumeDatabaseMigrationRollback(
  database: any,
  preflight: DatabasePreflight,
  options: DatabaseCheckpointOptions
) {
  const sourceName = database.name || options.sourceName || DATABASE_NAME;
  const state = await readMigrationRecoveryState(sourceName, options);
  if (!state) return undefined;
  const checkpoint = await readMigrationCheckpoint(state.checkpointName, { ...options, sourceName });
  const counts: any = { points: 0, snapshotPoints: 0 };
  for (const table of DATABASE_TABLES) counts[table] = checkpoint.counts[table] || 0;
  const recoveryPreflight: DatabasePreflight = {
    ...preflight, fromVersion: state.fromVersion, toVersion: state.toVersion,
    needsUpgrade: true, skipped: false, blocking: false, ok: true,
    stores: checkpoint.stores.map((store) => store.name), counts, issues: []
  };
  diag('store', 'database migration rollback resumed', {
    source: sourceName, checkpoint: checkpoint.databaseName, phase: state.phase
  });
  const migration = await rollbackDatabaseMigrationUnlocked(database, recoveryPreflight, checkpoint, options);
  try {
    await deleteRawDatabase(state.recoveryName, 'migration-rollback-blocked', options.deleteTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS);
  } catch (error) {
    diag('store', 'database migration stale recovery cleanup blocked', {
      recovery: state.recoveryName, code: (error as any)?.code || 'migration-rollback-cleanup-failed'
    });
  }
  return { migration, checkpoint, rolledBack: true };
}

export async function openDatabaseWithMigrationRecovery(
  database: any,
  preflight: DatabasePreflight,
  options: DatabaseCheckpointOptions = {}
): Promise<{ migration: DatabaseMigrationResult; checkpoint?: MigrationCheckpoint; rolledBack: boolean }> {
  return withDatabaseMigrationLock(async () => {
    const resumed = await resumeDatabaseMigrationRollback(database, preflight, options);
    if (resumed) return resumed;
    let checkpoint: MigrationCheckpoint | undefined;
    if (preflight.needsUpgrade && !preflight.skipped) {
      checkpoint = await createMigrationCheckpoint(preflight, { ...options, sourceName: database.name });
    }
    await database.open();
    try {
      const migration = await (options.verify || verifyDatabaseMigration)(database, preflight);
      return { migration, checkpoint, rolledBack: false };
    } catch (error) {
      if (!checkpoint) throw error;
      diag('store', 'database migration verification failed', {
        source: database.name, checkpoint: checkpoint.databaseName,
        code: (error as any)?.code || 'migration-verification-failed'
      });
      const migration = await rollbackDatabaseMigrationUnlocked(database, preflight, checkpoint, options);
      return { migration, checkpoint, rolledBack: true };
    }
  });
}
