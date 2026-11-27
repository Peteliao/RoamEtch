// Builds the ZIP (and optional password envelope) for a full backup.
// Kept free of IndexedDB and DOM so it can run inside a Worker.
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { sha256Hex, stableStringify } from './integrity';
import { encryptBackupBlob, ENCRYPTED_BACKUP_EXT } from './backupCrypto';

const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

const RESTORE_LIMIT_GUIDANCE = 'Use a smaller full backup, or export selected trips to GPX from the source device and import them individually. GPX does not include media or share-import history.';

export class BackupLimitError extends Error {
  readonly code = 'backup-limit-exceeded';

  constructor(message: string) {
    super(message);
    this.name = 'BackupLimitError';
  }
}

function exportLimit(message: string) {
  return new BackupLimitError(`${message} ${RESTORE_LIMIT_GUIDANCE}`);
}

function payloadOf(manifest) {
  const { integrity, ...payload } = manifest;
  return payload;
}

function payloadDigest(manifest) {
  return sha256Hex(stableStringify(payloadOf(manifest)));
}

async function blobToU8(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export interface BackupArchiveMedia {
  id: string;
  blob: Blob;
  thumb?: Blob | null;
}

export interface BackupArchiveInput {
  manifest: any;
  media: BackupArchiveMedia[];
  password?: string;
}

export async function buildBackupArchive({ manifest, media, password = '' }: BackupArchiveInput) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const fileHashes = {};
  let zipError: unknown = null;
  let zipBytes = 0;
  let uncompressedBytes = 0;
  let archiveEntries = 0;
  const zip = new Zip((error, chunk) => {
    if (error) zipError = error;
    else if (chunk.byteLength) {
      zipBytes += chunk.byteLength;
      if (zipBytes > MAX_BACKUP_BYTES) zipError = exportLimit('compressed backup exceeds the 256 MiB restore limit');
      chunks.push(chunk);
    }
  });
  const addEntry = (name: string, bytes: Uint8Array) => {
    if (bytes.byteLength > MAX_ENTRY_BYTES) throw exportLimit(`archive entry ${name} exceeds the 20 MiB restore limit`);
    if (name === 'manifest.json' && bytes.byteLength > MAX_MANIFEST_BYTES) {
      throw exportLimit('backup manifest exceeds the 16 MiB restore limit');
    }
    archiveEntries++;
    uncompressedBytes += bytes.byteLength;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw exportLimit('uncompressed backup exceeds the 512 MiB restore limit');
    const entry = new ZipDeflate(name, { level: 6 });
    zip.add(entry);
    for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024) {
      entry.push(bytes.subarray(offset, offset + 1024 * 1024));
    }
    entry.push(new Uint8Array(), true);
    if (zipError) throw zipError;
  };
  try {
    for (const m of media) {
      if (m.blob?.size > MAX_ENTRY_BYTES || m.thumb?.size > MAX_ENTRY_BYTES) {
        throw exportLimit(`media entry ${m.id} exceeds the 20 MiB restore limit`);
      }
      const photo = await blobToU8(m.blob);
      const photoPath = `media/${m.id}.jpg`;
      fileHashes[photoPath] = { bytes: photo.byteLength, sha256: await sha256Hex(photo) };
      addEntry(photoPath, photo);
      if (m.thumb) {
        const thumb = await blobToU8(m.thumb);
        const thumbPath = `media/${m.id}.thumb.jpg`;
        fileHashes[thumbPath] = { bytes: thumb.byteLength, sha256: await sha256Hex(thumb) };
        addEntry(thumbPath, thumb);
      }
    }
    manifest.integrity = {
      algo: 'SHA-256',
      payload: await payloadDigest(manifest),
      files: fileHashes
    };
    addEntry('manifest.json', strToU8(JSON.stringify(manifest)));
    zip.end();
    if (zipError) throw zipError;
  } catch (error) {
    zip.terminate();
    throw error;
  }
  const zipBlob = new Blob(chunks, { type: 'application/zip' });
  chunks.length = 0;
  const stamp = String(manifest.exportedAt).slice(0, 10).replace(/-/g, '');
  const encrypted = !!password;
  const blob = encrypted ? await encryptBackupBlob(zipBlob, password) : zipBlob;
  if (blob.size > MAX_BACKUP_BYTES) throw exportLimit('final backup envelope exceeds the 256 MiB restore limit');
  const filename = encrypted
    ? `roametch-backup-${stamp}${ENCRYPTED_BACKUP_EXT}`
    : `roametch-backup-${stamp}.trip`;
  return {
    blob,
    filename,
    exportedAt: manifest.exportedAt,
    encrypted,
    counts: manifest.counts,
    tripCount: manifest.counts?.trips ?? manifest.trips?.length ?? 0
  };
}
