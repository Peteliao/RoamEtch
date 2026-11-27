// Full-database backup / restore as a .trip ZIP archive (JSON tables + media binaries).
import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';
import { db, TRIP_SCHEMA_VERSION, abortTransactionOnSignal } from './store';
import { emit } from './events';
import { sha256Hex, stableStringify } from './integrity';
import { decryptBackupBytes, isEncryptedBackupBytes } from './backupCrypto';
import { BackupLimitError, buildBackupArchive } from './backupArchive';
import { buildBackupArchiveAsync } from './workerBridge';

const FORMAT = 'localtrace-backup';
const VERSION = 4;
const SUPPORTED_VERSIONS = new Set([1, 2, 3, 4]);

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_POINTS = 3_000_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const ZIP_INPUT_CHUNK_BYTES = 4 * 1024;
const ZIP_TAIL_BYTES = MAX_CENTRAL_DIRECTORY_BYTES + 22 + 65535;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MEDIA_PATH = /^media\/[A-Za-z0-9_-]{1,80}(?:\.thumb)?\.jpg$/;
const EMPTY_BYTES = new Uint8Array();

export interface BackupImportProgress {
  phase: 'read' | 'restore';
  loaded: number;
  total: number;
}

export type BackupTarget = Pick<typeof db,
  'trips' | 'segments' | 'trackChunks' | 'trackSnapshots' | 'waypoints' | 'media' | 'elevCache' | 'shareImports' | 'quarantine' | 'transaction'>;

export interface BackupImportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BackupImportProgress) => void;
  /** Defaults to the main database. A custom target never emits restore events. */
  target?: BackupTarget;
}

export interface BackupExportOptions {
  password?: string;
  /** Defaults to the main database. */
  target?: BackupTarget;
}

interface MediaEntryInfo {
  bytes: number;
  sha256: string;
}

interface ZipEntryObservation {
  name: string;
  compression: number;
  compressed: number;
  bytes: number;
}

interface ParsedZip {
  manifest: any;
  files: Record<string, Blob>;
  mediaInfo: Record<string, MediaEntryInfo>;
  inspectionVersion: 2;
}

export { BackupLimitError };

const RESTORE_LIMIT_GUIDANCE = 'Use a smaller full backup, or export selected trips to GPX from the source device and import them individually. GPX does not include media or share-import history.';

function archiveLimit(message: string) {
  return new BackupLimitError(message);
}

function restoreLimit(message: string) {
  return new BackupLimitError(`${message} ${RESTORE_LIMIT_GUIDANCE}`);
}

function exportLimit(message: string) {
  return archiveLimit(`${message} ${RESTORE_LIMIT_GUIDANCE}`);
}

function backupSizeLimit() {
  return restoreLimit(`backup file too large: the restore limit is 256 MiB (${MAX_BACKUP_BYTES} bytes)`);
}

function pointCountLimit() {
  return restoreLimit(`backup contains more than ${MAX_POINTS.toLocaleString('en-US')} track and snapshot points, exceeding the restore limit`);
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError(signal);
}

// WebCrypto digest is one-shot. This small incremental hasher lets each streamed
// media entry be verified without concatenating it or calling Blob.arrayBuffer().
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

class IncrementalSha256 {
  private state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private bytes = 0;
  private words = new Uint32Array(64);

  private rotate(value: number, bits: number) {
    return (value >>> bits) | (value << (32 - bits));
  }

  private block(data: Uint8Array) {
    const view = new DataView(data.buffer, data.byteOffset, 64);
    const words = this.words;
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = this.rotate(words[i - 15], 7) ^ this.rotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = this.rotate(words[i - 2], 17) ^ this.rotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const s1 = this.rotate(e, 6) ^ this.rotate(e, 11) ^ this.rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choice + SHA256_K[i] + words[i]) >>> 0;
      const s0 = this.rotate(a, 2) ^ this.rotate(a, 13) ^ this.rotate(a, 22);
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

  update(data: Uint8Array) {
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.buffered) {
      const take = Math.min(64 - this.buffered, data.byteLength);
      this.buffer.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset += take;
      if (this.buffered === 64) {
        this.block(this.buffer);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.block(data.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.buffer.set(data.subarray(offset));
      this.buffered = data.byteLength - offset;
    }
  }

  hex() {
    const bitLength = this.bytes * 8;
    this.buffer[this.buffered++] = 0x80;
    if (this.buffered > 56) {
      while (this.buffered < 64) this.buffer[this.buffered++] = 0;
      this.block(this.buffer);
      this.buffered = 0;
    }
    while (this.buffered < 56) this.buffer[this.buffered++] = 0;
    const view = new DataView(this.buffer.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.block(this.buffer);
    return Array.from(this.state, (word) => word.toString(16).padStart(8, '0')).join('');
  }
}

async function blobToU8(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

async function blobDigest(data: Blob | Uint8Array, signal?: AbortSignal) {
  const hash = new IncrementalSha256();
  if (!(data instanceof Blob)) {
    throwIfAborted(signal);
    hash.update(data);
    return hash.hex();
  }
  const reader = data.stream().getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) return hash.hex();
      if (value?.byteLength) hash.update(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* a failed read may already hold the lock */ }
  }
}

function payloadOf(manifest) {
  const { integrity, ...payload } = manifest;
  return payload;
}

function payloadDigest(manifest) {
  return sha256Hex(stableStringify(payloadOf(manifest)));
}

function mediaFilesOf(files, manifest) {
  const paths = new Set([
    ...Object.keys(files).filter((p) => p.startsWith('media/')),
    ...Object.keys(manifest.integrity?.files || {})
  ]);
  for (const m of manifest.mediaMeta || []) paths.add(`media/${m.id}.jpg`);
  return [...paths];
}

export async function exportBackup({ password = '', target = db }: BackupExportOptions = {}) {
  const [trips, segments, trackChunks, trackSnapshots, waypoints, media, elevCache, shareImports, quarantine] = await target.transaction(
    'r',
    [target.trips, target.segments, target.trackChunks, target.trackSnapshots, target.waypoints, target.media,
      target.elevCache, target.shareImports, target.quarantine],
    () => Promise.all([
      target.trips.toArray(), target.segments.toArray(), target.trackChunks.toArray(), target.trackSnapshots.toArray(),
      target.waypoints.toArray(), target.media.toArray(), target.elevCache.toArray(),
      target.shareImports.toArray(), target.quarantine.toArray()
    ])
  );
  const pointCount = trackChunks.reduce((sum, chunk) => sum + (chunk.points?.length || 0), 0)
    + trackSnapshots.reduce((sum, snapshot) => sum + (snapshot.points?.length || 0), 0);
  if (pointCount > MAX_POINTS) throw exportLimit(`backup contains more than ${MAX_POINTS.toLocaleString('en-US')} track and snapshot points`);
  const entryCount = 1 + media.reduce((sum, entry) => sum + (entry.thumb ? 2 : 1), 0);
  if (entryCount > MAX_ARCHIVE_ENTRIES) throw exportLimit(`backup would contain ${entryCount} archive entries, exceeding the ${MAX_ARCHIVE_ENTRIES.toLocaleString('en-US')} entry limit`);
  const exportedAt = new Date().toISOString();
  const manifest: any = {
    format: FORMAT, version: VERSION, exportedAt, tripSchemaVersion: TRIP_SCHEMA_VERSION,
    counts: {
      trips: trips.length, segments: segments.length, trackChunks: trackChunks.length,
      trackSnapshots: trackSnapshots.length, waypoints: waypoints.length, media: media.length,
      elevCache: elevCache.length, shareImports: shareImports.length, quarantine: quarantine.length
    },
    trips, segments, trackChunks, trackSnapshots, waypoints,
    mediaMeta: media.map((m) => ({ id: m.id, tripId: m.tripId, width: m.width, height: m.height, createdAt: m.createdAt })),
    elevCache, shareImports, quarantine
  };
  const archive = await buildBackupArchiveAsync({
    manifest,
    media: media.map((m) => ({ id: m.id, blob: m.blob, thumb: m.thumb })),
    password
  });
  return {
    blob: archive.blob,
    filename: archive.filename,
    tripCount: trips.length,
    exportedAt,
    counts: manifest.counts,
    encrypted: archive.encrypted
  };
}

async function* byteChunks(data: Uint8Array, signal?: AbortSignal) {
  for (let offset = 0; offset < data.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
    throwIfAborted(signal);
    yield data.subarray(offset, offset + ZIP_INPUT_CHUNK_BYTES);
  }
}

function normalizeZipError(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted) throw abortError(signal);
  if (error instanceof BackupLimitError) throw error;
  throw new Error('not a zip');
}

function joinTail(parts: Uint8Array[], head: number, length: number) {
  const tail = new Uint8Array(length);
  let offset = 0;
  for (let index = head; index < parts.length; index++) {
    tail.set(parts[index], offset);
    offset += parts[index].byteLength;
  }
  return tail;
}

function validateZipDirectory(tail: Uint8Array, archiveBytes: number, entries: ZipEntryObservation[]) {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const firstEocd = Math.max(0, tail.byteLength - 22 - 65535);
  let eocd = -1;
  for (let offset = tail.byteLength - 22; offset >= firstEocd; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) === tail.byteLength) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('not a zip');

  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries || totalEntries !== entries.length) throw new Error('not a zip');
  if (diskEntries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw restoreLimit('zip64 directory is not supported');
  }
  if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize !== archiveBytes - tail.byteLength + eocd) {
    throw new Error('not a zip');
  }

  const tailOffset = archiveBytes - tail.byteLength;
  if (directoryOffset < tailOffset) throw new Error('not a zip');
  const directoryStart = directoryOffset - tailOffset;
  const directoryEnd = directoryStart + directorySize;
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const localOffsets = new Set<number>();
  const decoder = new TextDecoder();
  let cursor = directoryStart;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('not a zip');
    const flags = view.getUint16(cursor + 8, true);
    const compression = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const bytes = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const entryDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > directoryEnd || entryDisk !== 0 || flags & 1 || localOffset >= directoryOffset || localOffsets.has(localOffset)) {
      throw new Error('not a zip');
    }
    const name = decoder.decode(tail.subarray(cursor + 46, cursor + 46 + nameLength));
    const observed = byName.get(name);
    if (!observed || observed.compression !== compression || observed.compressed !== compressed || observed.bytes !== bytes) {
      throw new Error('not a zip');
    }
    localOffsets.add(localOffset);
    cursor = next;
  }
  if (cursor !== directoryEnd || localOffsets.size !== entries.length) throw new Error('not a zip');
}

async function readZip(chunks: AsyncIterable<Uint8Array>, options: BackupImportOptions): Promise<ParsedZip> {
  const files: Record<string, Blob> = {};
  const mediaInfo: Record<string, MediaEntryInfo> = {};
  const names = new Set<string>();
  let manifestText = '';
  let manifestSeen = false;
  let archiveStarted = false;
  let entryCount = 0;
  let totalUncompressed = 0;
  let archiveBytes = 0;
  let tailBytes = 0;
  let tailHead = 0;
  const tailParts: Uint8Array[] = [];
  const observations: ZipEntryObservation[] = [];
  let activeFile: UnzipFile | null = null;
  let current: {
    file: UnzipFile;
    name: string;
    kind: 'manifest' | 'media';
    bytes: number;
    accounted: number;
    compressed: number;
    parts: Uint8Array<ArrayBuffer>[];
    decoder: TextDecoder | null;
    hash: IncrementalSha256 | null;
  } | null = null;

  class RatioCheckingUnzipInflate extends UnzipInflate {
    static compression = 8;
    push(chunk: Uint8Array, final: boolean) {
      const entry = current;
      if (entry) entry.compressed += chunk.byteLength;
      super.push(chunk, final);
      // Streaming ZIP local headers may omit sizes when a data descriptor is
      // used. Enforce the same ratio limit from observed bytes in that case.
      if (entry && entry.bytes > 8 * 1024 * 1024 && entry.compressed > 0
        && entry.bytes / entry.compressed > 200) throw archiveLimit('suspicious compression ratio');
    }
  }

  const finishEntry = () => {
    if (!current) return;
    observations.push({
      name: current.name,
      compression: current.file.compression,
      compressed: current.file.compression === 0 ? current.bytes : current.compressed,
      bytes: current.bytes
    });
    if (current.kind === 'manifest') {
      manifestText += current.decoder!.decode();
      manifestSeen = true;
    } else {
      files[current.name] = new Blob(current.parts, { type: 'image/jpeg' });
      mediaInfo[current.name] = { bytes: current.bytes, sha256: current.hash!.hex() };
    }
    current.parts.length = 0;
    current = null;
    activeFile = null;
  };

  const unzip = new Unzip((file) => {
    throwIfAborted(options.signal);
    archiveStarted = true;
    entryCount++;
    if (entryCount > MAX_ARCHIVE_ENTRIES) throw restoreLimit(`too many files: the restore limit is ${MAX_ARCHIVE_ENTRIES.toLocaleString('en-US')} archive entries`);
    if (names.has(file.name)) throw archiveLimit('duplicate archive entry');
    names.add(file.name);
    if (file.name !== 'manifest.json' && !MEDIA_PATH.test(file.name)) throw archiveLimit('unsafe archive path');

    const declaredSize = file.originalSize;
    const kind: 'manifest' | 'media' = file.name === 'manifest.json' ? 'manifest' : 'media';
    if (declaredSize != null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0)) throw new Error('not a zip');
    if ((declaredSize ?? 0) > MAX_ENTRY_BYTES) throw restoreLimit(`archive entry too large: the restore limit is 20 MiB (${MAX_ENTRY_BYTES} bytes)`);
    if (kind === 'manifest' && (declaredSize ?? 0) > MAX_MANIFEST_BYTES) throw restoreLimit(`manifest too large: the restore limit is 16 MiB (${MAX_MANIFEST_BYTES} bytes)`);
    if ((declaredSize ?? 0) > 8 * 1024 * 1024 && (file.size ?? 0) > 0 && declaredSize! / file.size! > 200) {
      throw archiveLimit('suspicious compression ratio');
    }
    totalUncompressed += declaredSize ?? 0;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw restoreLimit(`archive expands too large: the restore limit is 512 MiB (${MAX_UNCOMPRESSED_BYTES} bytes)`);

    const entry = {
      file,
      name: file.name,
      kind,
      bytes: 0,
      accounted: declaredSize ?? 0,
      compressed: 0,
      parts: [] as Uint8Array<ArrayBuffer>[],
      decoder: kind === 'manifest' ? new TextDecoder('utf-8') : null,
      hash: kind === 'media' ? new IncrementalSha256() : null
    };
    current = entry;
    activeFile = file;
    file.ondata = (error, data, final) => {
      if (error) throw new Error('not a zip');
      throwIfAborted(options.signal);
      if (data?.byteLength) {
        entry.bytes += data.byteLength;
        if (entry.bytes > MAX_ENTRY_BYTES) throw restoreLimit(`archive entry too large: the restore limit is 20 MiB (${MAX_ENTRY_BYTES} bytes)`);
        if (kind === 'manifest' && entry.bytes > MAX_MANIFEST_BYTES) throw restoreLimit(`manifest too large: the restore limit is 16 MiB (${MAX_MANIFEST_BYTES} bytes)`);
        const accounted = Math.max(entry.accounted, entry.bytes);
        totalUncompressed += accounted - entry.accounted;
        entry.accounted = accounted;
        if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw restoreLimit(`archive expands too large: the restore limit is 512 MiB (${MAX_UNCOMPRESSED_BYTES} bytes)`);
        if (kind === 'manifest') manifestText += entry.decoder!.decode(data, { stream: true });
        else {
          entry.parts.push(data);
          entry.hash!.update(data);
        }
      }
      if (final) finishEntry();
    };
    file.start();
  });
  unzip.register(RatioCheckingUnzipInflate);

  const retainTail = (chunk: Uint8Array) => {
    if (!chunk.byteLength) return;
    tailParts.push(chunk);
    tailBytes += chunk.byteLength;
    while (tailBytes > ZIP_TAIL_BYTES && tailHead < tailParts.length) {
      const excess = tailBytes - ZIP_TAIL_BYTES;
      const first = tailParts[tailHead];
      if (first.byteLength <= excess) {
        tailBytes -= first.byteLength;
        tailHead++;
      } else {
        tailParts[tailHead] = first.subarray(excess);
        tailBytes -= excess;
      }
    }
    if (tailHead > 1024 && tailHead * 2 >= tailParts.length) {
      tailParts.splice(0, tailHead);
      tailHead = 0;
    }
  };

  try {
    for await (const input of chunks) {
      throwIfAborted(options.signal);
      for (let offset = 0; offset < input.byteLength; offset += ZIP_INPUT_CHUNK_BYTES) {
        const chunk = input.subarray(offset, offset + ZIP_INPUT_CHUNK_BYTES);
        archiveBytes += chunk.byteLength;
        if (archiveBytes > MAX_BACKUP_BYTES) throw backupSizeLimit();
        retainTail(chunk);
        try { unzip.push(chunk, false); } catch (error) { normalizeZipError(error, options.signal); }
      }
    }
    throwIfAborted(options.signal);
    try { unzip.push(EMPTY_BYTES, true); } catch (error) { normalizeZipError(error, options.signal); }
    if (!archiveStarted) throw new Error('not a zip');
    validateZipDirectory(joinTail(tailParts, tailHead, tailBytes), archiveBytes, observations);
    if (!manifestSeen) throw new Error('missing manifest');
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { throw new Error('invalid manifest'); }
    return { manifest, files, mediaInfo, inspectionVersion: 2 };
  } finally {
    try { activeFile?.terminate(); } catch { /* best-effort decoder cleanup */ }
    // fflate 0.8 exposes per-file termination only; tolerate newer versions
    // that also expose a stream-level terminator.
    try { (unzip as Unzip & { terminate?: () => void }).terminate?.(); } catch { /* best-effort */ }
  }
}

function invalidManifest() {
  throw new Error('invalid manifest');
}

function checkId(value) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) invalidManifest();
  return value;
}

function repairMetadataSignature(snapshot) {
  return stableStringify({
    kind: snapshot.kind,
    repairVersion: snapshot.repairVersion,
    createdAt: snapshot.createdAt,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    previewId: snapshot.previewId,
    sourceFingerprint: snapshot.sourceFingerprint,
    selectedCategories: snapshot.selectedCategories,
    summary: snapshot.summary,
    metrics: snapshot.metrics,
    semantics: snapshot.semantics
  });
}

function validateRepairSnapshot(snapshot) {
  checkId(snapshot.snapshotId);
  if (snapshot.kind !== 'repair' || !Number.isSafeInteger(snapshot.repairVersion) || snapshot.repairVersion < 1
    || !Number.isFinite(snapshot.sourceUpdatedAt)
    || typeof snapshot.previewId !== 'string' || !snapshot.previewId
    || typeof snapshot.sourceFingerprint !== 'string' || !snapshot.sourceFingerprint
    || !Array.isArray(snapshot.selectedCategories) || snapshot.selectedCategories.some((category) => typeof category !== 'string')
    || !snapshot.summary || typeof snapshot.summary !== 'object' || Array.isArray(snapshot.summary)
    || !snapshot.metrics || typeof snapshot.metrics !== 'object' || Array.isArray(snapshot.metrics)
    || !snapshot.semantics || typeof snapshot.semantics !== 'object' || Array.isArray(snapshot.semantics)) invalidManifest();
}

function validateBackupSchemaVersion(value) {
  if (value == null) return;
  if (!Number.isSafeInteger(value) || value < 1) invalidManifest();
  if (value > TRIP_SCHEMA_VERSION) {
    const error = new Error('unsupported trip schema version') as Error & { code: string };
    error.code = 'backup-trip-schema-unsupported';
    throw error;
  }
}

function validateManifest(manifest, files) {
  if (manifest.format !== FORMAT) throw new Error('wrong format');
  if (!SUPPORTED_VERSIONS.has(manifest.version)) throw new Error('unsupported version');
  validateBackupSchemaVersion(manifest.tripSchemaVersion);
  for (const key of ['trips', 'segments', 'trackChunks', 'waypoints', 'mediaMeta', 'elevCache']) {
    if (!Array.isArray(manifest[key])) invalidManifest();
  }
  if ((manifest.version === 3 && !Array.isArray(manifest.trackSnapshots))
    || (manifest.trackSnapshots != null && !Array.isArray(manifest.trackSnapshots))) invalidManifest();
  if (manifest.version >= 4 && (!Array.isArray(manifest.shareImports) || !Array.isArray(manifest.quarantine))) invalidManifest();
  if ((manifest.shareImports != null && !Array.isArray(manifest.shareImports))
    || (manifest.quarantine != null && !Array.isArray(manifest.quarantine))) invalidManifest();
  if (manifest.version >= 2) {
    const integrity = manifest.integrity;
    if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)
      || integrity.algo !== 'SHA-256' || typeof integrity.payload !== 'string'
      || (integrity.files != null && (typeof integrity.files !== 'object' || Array.isArray(integrity.files)))) {
      invalidManifest();
    }
  }
  const trackSnapshots = manifest.trackSnapshots || [];
  const shareImports = manifest.shareImports || [];
  const quarantine = manifest.quarantine || [];

  const countPairs = [
    ['trips', manifest.trips],
    ['segments', manifest.segments],
    ['trackChunks', manifest.trackChunks],
    ['trackSnapshots', trackSnapshots],
    ['waypoints', manifest.waypoints],
    ['media', manifest.mediaMeta],
    ['elevCache', manifest.elevCache],
    ['shareImports', shareImports],
    ['quarantine', quarantine]
  ];
  if (manifest.counts != null) {
    if (typeof manifest.counts !== 'object') invalidManifest();
    for (const [key, list] of countPairs) {
      if (key in manifest.counts && manifest.counts[key] !== list.length) invalidManifest();
    }
  }

  const tripIds = new Set();
  for (const t of manifest.trips) {
    if (!t || typeof t !== 'object') invalidManifest();
    const id = checkId(t.id);
    if (tripIds.has(id)) invalidManifest();
    validateBackupSchemaVersion(t.schemaVersion);
    tripIds.add(id);
  }

  const segTrip = new Map();
  const segIndex = new Map();
  for (const s of manifest.segments) {
    if (!s || typeof s !== 'object') invalidManifest();
    const id = checkId(s.id);
    if (segTrip.has(id) || !tripIds.has(s.tripId)) invalidManifest();
    segTrip.set(id, s.tripId);
    segIndex.set(id, s.index);
  }

  let pointCount = 0;
  const chunkIds = new Set();
  const chunkSeqs = new Set();
  const chunkSeqsBySegment = new Map();
  for (const c of manifest.trackChunks) {
    if (!c || typeof c !== 'object') invalidManifest();
    const id = checkId(c.id);
    const segmentId = checkId(c.segmentId);
    if (chunkIds.has(id) || segTrip.get(segmentId) !== c.tripId
      || !Number.isSafeInteger(c.seq) || c.seq < 0 || !Array.isArray(c.points)) invalidManifest();
    const sequenceKey = `${segmentId}:${c.seq}`;
    if (chunkSeqs.has(sequenceKey)) invalidManifest();
    chunkSeqs.add(sequenceKey);
    if (!chunkSeqsBySegment.has(segmentId)) chunkSeqsBySegment.set(segmentId, []);
    chunkSeqsBySegment.get(segmentId).push(c.seq);
    chunkIds.add(id);
    pointCount += c.points.length;
    if (pointCount > MAX_POINTS) throw pointCountLimit();
    for (const p of c.points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
        || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) invalidManifest();
      if (p.t != null && !Number.isFinite(p.t)) invalidManifest();
    }
  }

  for (const seqs of chunkSeqsBySegment.values()) {
    seqs.sort((a, b) => a - b);
    if (seqs.some((seq, index) => seq !== index)) invalidManifest();
  }

  const snapshotIds = new Set();
  const snapshotGroups = new Map();
  const repairVersionOwners = new Map();
  for (const snapshot of trackSnapshots) {
    if (!snapshot || typeof snapshot !== 'object') invalidManifest();
    const id = checkId(snapshot.id);
    if (snapshotIds.has(id) || !tripIds.has(snapshot.tripId)) invalidManifest();
    const segmentId = checkId(snapshot.segmentId);
    if (segTrip.get(segmentId) !== snapshot.tripId) invalidManifest();
    if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0
      || !Number.isSafeInteger(snapshot.segmentIndex) || snapshot.segmentIndex < 0
      || segIndex.get(segmentId) !== snapshot.segmentIndex) invalidManifest();
    if (!Number.isFinite(snapshot.createdAt) || !Array.isArray(snapshot.points)) invalidManifest();
    let groupId;
    if (snapshot.snapshotId != null) {
      validateRepairSnapshot(snapshot);
      groupId = snapshot.snapshotId;
      const versionKey = `${snapshot.tripId}:${snapshot.repairVersion}`;
      const owner = repairVersionOwners.get(versionKey);
      if (owner && owner !== groupId) invalidManifest();
      repairVersionOwners.set(versionKey, groupId);
    } else {
      if (snapshot.kind != null || snapshot.repairVersion != null) invalidManifest();
      groupId = `raw:${snapshot.tripId}`;
    }
    let group = snapshotGroups.get(groupId);
    if (!group) snapshotGroups.set(groupId, group = {
      signature: repairMetadataSignature(snapshot), sequences: new Map()
    });
    if (group.signature !== repairMetadataSignature(snapshot)) invalidManifest();
    let sequences = group.sequences.get(segmentId);
    if (!sequences) group.sequences.set(segmentId, sequences = new Set());
    if (sequences.has(snapshot.seq)) invalidManifest();
    sequences.add(snapshot.seq);
    snapshotIds.add(id);
    pointCount += snapshot.points.length;
    if (pointCount > MAX_POINTS) throw pointCountLimit();
    for (const p of snapshot.points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
        || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180
        || (p.t != null && !Number.isFinite(p.t))) invalidManifest();
    }
  }

  for (const group of snapshotGroups.values()) {
    for (const sequences of group.sequences.values()) {
      const seqs = [...sequences].sort((a, b) => a - b);
      if (seqs.some((seq, index) => seq !== index)) invalidManifest();
    }
  }

  const waypointIds = new Set();
  for (const w of manifest.waypoints) {
    if (!w || typeof w !== 'object') invalidManifest();
    const id = checkId(w.id);
    if (waypointIds.has(id) || !tripIds.has(w.tripId)) invalidManifest();
    waypointIds.add(id);
    if (!Number.isFinite(w.lat) || !Number.isFinite(w.lon)
      || Math.abs(w.lat) > 90 || Math.abs(w.lon) > 180) invalidManifest();
  }

  const mediaIds = new Set();
  for (const m of manifest.mediaMeta) {
    if (!m || typeof m !== 'object') invalidManifest();
    const id = checkId(m.id);
    if (mediaIds.has(id) || !tripIds.has(m.tripId)) invalidManifest();
    mediaIds.add(id);
    if (!files[`media/${id}.jpg`]) throw new Error('missing media');
  }

  for (const e of manifest.elevCache) {
    if (!e || typeof e !== 'object' || typeof e.key !== 'string') invalidManifest();
  }

  const fingerprints = new Set();
  for (const entry of shareImports) {
    if (!entry || typeof entry !== 'object' || typeof entry.fingerprint !== 'string'
      || !entry.fingerprint || entry.fingerprint.length > 16_384 || fingerprints.has(entry.fingerprint)
      || !tripIds.has(entry.tripId) || !Number.isFinite(entry.createdAt)) invalidManifest();
    fingerprints.add(entry.fingerprint);
  }

  const quarantineIds = new Set();
  for (const entry of quarantine) {
    if (!entry || typeof entry !== 'object') invalidManifest();
    const id = checkId(entry.id);
    checkId(entry.batchId);
    checkId(entry.rowId);
    if (quarantineIds.has(id) || !Number.isFinite(entry.createdAt) || entry.createdAt < 0
      || !['segments', 'trackChunks', 'trackSnapshots'].includes(entry.sourceTable)
      || typeof entry.reason !== 'string' || !entry.reason || entry.reason.length > 120
      || (entry.tripId != null && (typeof entry.tripId !== 'string' || !entry.tripId))
      || !entry.row || typeof entry.row !== 'object' || entry.row.id !== entry.rowId) invalidManifest();
    quarantineIds.add(id);
  }
}

async function finishInspection(parsed: ParsedZip, encrypted: boolean, options: BackupImportOptions) {
  const { manifest, files, mediaInfo } = parsed;
  const target = options.target ?? db;
  throwIfAborted(options.signal);
  validateManifest(manifest, files);
  const existing = new Set((await target.trips.toArray()).map((t) => t.id));
  throwIfAborted(options.signal);
  const conflicts = manifest.trips.filter((t) => existing.has(t.id)).map((t) => t.id);
  const integrity = await verifyIntegrity(manifest, files, mediaInfo, options.signal);
  throwIfAborted(options.signal);
  return { manifest, files, conflicts, integrity, encrypted, inspectionVersion: parsed.inspectionVersion };
}

async function inspectStreamingFile(file, password: string, options: BackupImportOptions) {
  const maxEnvelope = MAX_BACKUP_BYTES;
  const reader = file.stream().getReader();
  const total = Number(file.size) || 0;
  let loaded = 0;
  let completed = false;
  let cancelled = false;
  const cancel = async () => {
    if (cancelled || completed) return;
    cancelled = true;
    try { await reader.cancel(); } catch { /* preserve the original failure */ }
  };
  const read = async () => {
    throwIfAborted(options.signal);
    let result;
    if (!options.signal) {
      result = await reader.read();
    } else {
      let onAbort: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          void cancel();
          reject(abortError(options.signal!));
        };
        options.signal!.addEventListener('abort', onAbort, { once: true });
      });
      try {
        result = await Promise.race([reader.read(), aborted]);
      } finally {
        options.signal!.removeEventListener('abort', onAbort!);
      }
    }
    throwIfAborted(options.signal);
    if (!result.done && result.value?.byteLength) {
      loaded += result.value.byteLength;
      if (loaded > maxEnvelope) throw backupSizeLimit();
      options.onProgress?.({ phase: 'read', loaded, total });
    }
    return result;
  };

  try {
    const prefix: Uint8Array[] = [];
    let prefixBytes = 0;
    let eof = false;
    while (prefixBytes < 8 && !eof) {
      const result = await read();
      if (result.done) eof = true;
      else if (result.value?.byteLength) {
        prefix.push(result.value);
        prefixBytes += result.value.byteLength;
      }
    }
    const header = new Uint8Array(Math.min(8, prefixBytes));
    let headerOffset = 0;
    for (const chunk of prefix) {
      const take = Math.min(chunk.byteLength, header.byteLength - headerOffset);
      header.set(chunk.subarray(0, take), headerOffset);
      headerOffset += take;
    }

    if (isEncryptedBackupBytes(header)) {
      await cancel();
      throwIfAborted(options.signal);
      // Compatibility boundary: the v1 AES-GCM envelope requires the complete
      // ciphertext for one-shot decryption. Encrypted imports are deliberately
      // not streaming; only the ZIP/media handling below is bounded per entry.
      let wrapped = await blobToU8(file);
      throwIfAborted(options.signal);
      if (wrapped.byteLength > maxEnvelope) throw backupSizeLimit();
      let plain = await decryptBackupBytes(wrapped, password);
      throwIfAborted(options.signal);
      if (plain.byteLength > MAX_BACKUP_BYTES) throw backupSizeLimit();
      wrapped = EMPTY_BYTES;
      const parsed = await readZip(byteChunks(plain, options.signal), options);
      plain = EMPTY_BYTES;
      const inspected = await finishInspection(parsed, true, options);
      completed = true;
      return inspected;
    }

    const zipPrefix = header[0] === 0x50 && header[1] === 0x4b;
    const chunks = (async function* () {
      if (zipPrefix) for (const chunk of prefix) yield chunk;
      if (eof) return;
      for (;;) {
        const result = await read();
        if (result.done) return;
        if (zipPrefix && result.value?.byteLength) yield result.value;
        else yield EMPTY_BYTES;
      }
    })();
    const parsed = await readZip(chunks, options);
    const inspected = await finishInspection(parsed, false, options);
    completed = true;
    return inspected;
  } finally {
    await cancel();
    try { reader.releaseLock(); } catch { /* a cancelled pending read may already hold the lock */ }
  }
}

async function inspectBufferedFile(file, password: string, options: BackupImportOptions) {
  const maxEnvelope = MAX_BACKUP_BYTES;
  let u8 = await blobToU8(file);
  throwIfAborted(options.signal);
  if (u8.byteLength > maxEnvelope) throw backupSizeLimit();
  const encrypted = isEncryptedBackupBytes(u8);
  if (encrypted) {
    u8 = await decryptBackupBytes(u8, password);
    throwIfAborted(options.signal);
    if (u8.byteLength > MAX_BACKUP_BYTES) throw backupSizeLimit();
  }
  const parsed = await readZip(byteChunks(u8, options.signal), options);
  return await finishInspection(parsed, encrypted, options);
}

export async function inspectBackup(file, password = '', options: BackupImportOptions = {}) {
  const maxEnvelope = MAX_BACKUP_BYTES;
  if (Number(file?.size) > maxEnvelope) throw backupSizeLimit();
  throwIfAborted(options.signal);
  // Blob/File inputs use their stream. The arrayBuffer fallback keeps older
  // non-streaming callers compatible, but cannot provide the streaming guarantee.
  return typeof file?.stream === 'function'
    ? inspectStreamingFile(file, password, options)
    : inspectBufferedFile(file, password, options);
}

async function verifyIntegrity(
  manifest,
  files: Record<string, Blob>,
  mediaInfo: Record<string, MediaEntryInfo> | null,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  if (!manifest.integrity) return { ok: null, checked: 0, failed: [] };
  if (manifest.integrity.algo !== 'SHA-256' || typeof manifest.integrity.payload !== 'string') {
    return { ok: false, checked: 0, failed: ['unsupported checksum'] };
  }
  const expected = manifest.integrity.payload;
  const actual = await payloadDigest(manifest);
  throwIfAborted(signal);
  if (actual !== expected) return { ok: false, checked: 0, failed: ['manifest'] };
  const failed = [];
  let checked = 0;
  for (const path of mediaFilesOf(files, manifest)) {
    throwIfAborted(signal);
    const meta = manifest.integrity.files?.[path];
    const data = files[path];
    const binary = data as Blob | Uint8Array | undefined;
    const info = mediaInfo === null && binary
      ? {
        bytes: binary instanceof Blob ? binary.size : binary.byteLength,
        sha256: await blobDigest(binary, signal)
      }
      : mediaInfo?.[path];
    if (!meta || !data || !info) { failed.push(path); continue; }
    checked++;
    if (info.bytes !== meta.bytes || info.sha256 !== meta.sha256) failed.push(path);
  }
  throwIfAborted(signal);
  return { ok: failed.length === 0, checked, failed };
}

/** strategy: 'skip' | 'overwrite' */
export async function restoreBackup(file, strategy = 'skip', inspected = null, options: BackupImportOptions = {}) {
  if (strategy !== 'skip' && strategy !== 'overwrite') throw new Error('invalid strategy');
  throwIfAborted(options.signal);
  const target = options.target ?? db;
  const data = inspected || await inspectBackup(file, '', options);
  const { manifest, files } = data;
  validateBackupSchemaVersion(manifest.tripSchemaVersion);
  for (const trip of manifest.trips) validateBackupSchemaVersion(trip.schemaVersion);
  validateManifest(manifest, files);
  const integrity = inspected
    ? await verifyIntegrity(manifest, files, null, options.signal)
    : data.integrity;
  if (integrity.ok === false) throw new Error('backup integrity check failed');
  throwIfAborted(options.signal);
  const trackSnapshots = manifest.trackSnapshots || [];
  const shareImports = manifest.shareImports || [];
  const quarantine = manifest.quarantine || [];
  let restored = 0;
  const noExisting = async (table, ids, tableName: string) => {
    if (!ids.length) return;
    const rows = await table.bulkGet(ids);
    throwIfAborted(options.signal);
    if (rows.some(Boolean)) throw new Error(`archive id collision in ${tableName}`);
  };
  let detachAbort: (() => void) | undefined;
  try {
    await target.transaction('rw', [target.trips, target.segments, target.trackChunks, target.trackSnapshots,
      target.waypoints, target.media, target.elevCache, target.shareImports, target.quarantine], async (transaction) => {
      detachAbort = abortTransactionOnSignal(transaction, options.signal);
      restored = 0;
      throwIfAborted(options.signal);
      const archivedTripIds = manifest.trips.map((trip) => trip.id);
      const currentTrips = await target.trips.bulkGet(archivedTripIds);
      throwIfAborted(options.signal);
      const liveConflicts = archivedTripIds.filter((_id, index) => !!currentTrips[index]);
      const skipIds = new Set(strategy === 'skip' ? liveConflicts : []);
      if (strategy === 'overwrite') {
        for (const id of liveConflicts) {
          throwIfAborted(options.signal);
          await target.trackChunks.where('tripId').equals(id).delete();
          await target.trackSnapshots.where('tripId').equals(id).delete();
          await target.segments.where('tripId').equals(id).delete();
          await target.waypoints.where('tripId').equals(id).delete();
          await target.media.where('tripId').equals(id).delete();
          await target.quarantine.where('tripId').equals(id).delete();
          if (manifest.version >= 4) await target.shareImports.where('tripId').equals(id).delete();
          await target.trips.delete(id);
        }
      }
      await noExisting(target.trips, manifest.trips.filter((t) => !skipIds.has(t.id)).map((t) => t.id), 'trips');
      await noExisting(target.segments, manifest.segments.filter((s) => !skipIds.has(s.tripId)).map((s) => s.id), 'segments');
      await noExisting(target.trackChunks, manifest.trackChunks.filter((c) => !skipIds.has(c.tripId)).map((c) => c.id), 'trackChunks');
      await noExisting(target.trackSnapshots, trackSnapshots.filter((snapshot) => !skipIds.has(snapshot.tripId)).map((snapshot) => snapshot.id), 'trackSnapshots');
      await noExisting(target.waypoints, manifest.waypoints.filter((w) => !skipIds.has(w.tripId)).map((w) => w.id), 'waypoints');
      await noExisting(target.media, manifest.mediaMeta.filter((m) => !skipIds.has(m.tripId)).map((m) => m.id), 'media');
      await noExisting(target.quarantine, quarantine.filter((entry) => !skipIds.has(entry.tripId)).map((entry) => entry.id), 'quarantine');
      for (const t of manifest.trips) {
        if (skipIds.has(t.id)) continue;
        throwIfAborted(options.signal);
        await target.trips.put({ ...t, schemaVersion: t.schemaVersion ?? TRIP_SCHEMA_VERSION });
        restored++;
        options.onProgress?.({ phase: 'restore', loaded: restored, total: manifest.trips.length });
        throwIfAborted(options.signal);
      }
      for (const s of manifest.segments) if (!skipIds.has(s.tripId)) { throwIfAborted(options.signal); await target.segments.put(s); }
      for (const c of manifest.trackChunks) if (!skipIds.has(c.tripId)) { throwIfAborted(options.signal); await target.trackChunks.put(c); }
      for (const snapshot of trackSnapshots) if (!skipIds.has(snapshot.tripId)) { throwIfAborted(options.signal); await target.trackSnapshots.put(snapshot); }
      for (const w of manifest.waypoints) if (!skipIds.has(w.tripId)) { throwIfAborted(options.signal); await target.waypoints.put(w); }
      for (const e of manifest.elevCache || []) { throwIfAborted(options.signal); await target.elevCache.put(e); }
      for (const m of manifest.mediaMeta || []) {
        if (skipIds.has(m.tripId)) continue;
        throwIfAborted(options.signal);
        const blobData = files[`media/${m.id}.jpg`];
        if (!blobData) throw new Error('missing media');
        const thumbData = files[`media/${m.id}.thumb.jpg`];
        // Inspections retain media as Blobs, so restore reuses those exact objects
        // instead of materializing every entry again. The fallback accepts an
        // inspection produced by an older caller that supplied Uint8Arrays.
        const blob = blobData instanceof Blob ? blobData : new Blob([blobData], { type: 'image/jpeg' });
        const thumb = thumbData
          ? thumbData instanceof Blob ? thumbData : new Blob([thumbData], { type: 'image/jpeg' })
          : null;
        await target.media.put({ ...m, blob, thumb });
      }
      for (const entry of shareImports) {
        if (skipIds.has(entry.tripId)) continue;
        throwIfAborted(options.signal);
        if (await target.shareImports.get(entry.fingerprint)) continue;
        await target.shareImports.put(entry);
      }
      for (const entry of quarantine) {
        if (skipIds.has(entry.tripId)) continue;
        throwIfAborted(options.signal);
        await target.quarantine.put(entry);
      }
      throwIfAborted(options.signal);
    });
  } finally {
    detachAbort?.();
  }
  if (target === db) emit('backup:restored', { restored });
  return restored;
}
