// Optional password envelope for full backups. The ZIP inside is unchanged;
// this layer only makes an exported file unreadable without the passphrase.
// Format: 8-byte magic | kdf id | 4-byte iterations | 16-byte salt |
//         12-byte GCM nonce | AES-256-GCM ciphertext and tag.
const MAGIC = new TextEncoder().encode('TRKMBKP1');
const KDF_PBKDF2_SHA256 = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + 4 + SALT_BYTES + NONCE_BYTES;
const DEFAULT_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 2_000_000;

export const MIN_BACKUP_PASSWORD = 8;
export const ENCRYPTED_BACKUP_EXT = '.roametch.enc';

export type BackupCryptoErrorCode =
  | 'backup-password-required'
  | 'backup-password-weak'
  | 'backup-decrypt-failed'
  | 'backup-encrypted-unsupported';

export class BackupCryptoError extends Error {
  code: BackupCryptoErrorCode;
  constructor(code: BackupCryptoErrorCode, message = code) {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
  }
}

function headerBytes(iterations: number, salt: Uint8Array, nonce: Uint8Array) {
  const header = new Uint8Array(HEADER_BYTES);
  header.set(MAGIC, 0);
  header[8] = KDF_PBKDF2_SHA256;
  new DataView(header.buffer).setUint32(9, iterations, false);
  header.set(salt, 13);
  header.set(nonce, 29);
  return header;
}

function randomBytes(length: number) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function ownedBytes(data: Uint8Array) {
  return new Uint8Array(data);
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: ownedBytes(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function checkPassword(password: string) {
  if (!password) throw new BackupCryptoError('backup-password-required');
  if (password.length < MIN_BACKUP_PASSWORD) throw new BackupCryptoError('backup-password-weak');
}

export function isEncryptedBackupBytes(data: Uint8Array) {
  if (data.byteLength < MAGIC.length) return false;
  return MAGIC.every((v, i) => data[i] === v);
}

export async function isEncryptedBackupFile(file: any) {
  let head: Uint8Array;
  try {
    head = file?.slice
      ? new Uint8Array(await file.slice(0, MAGIC.length).arrayBuffer())
      : new Uint8Array(await file.arrayBuffer()).subarray(0, MAGIC.length);
  } catch {
    return false;
  }
  return isEncryptedBackupBytes(head);
}

export async function encryptBackupBytes(
  data: Uint8Array,
  password: string,
  { iterations = DEFAULT_ITERATIONS }: { iterations?: number } = {}
) {
  checkPassword(password);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new BackupCryptoError('backup-encrypted-unsupported');
  }
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const header = headerBytes(iterations, salt, nonce);
  const key = await deriveKey(password, salt, iterations);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBytes(nonce), additionalData: ownedBytes(header), tagLength: TAG_BYTES * 8 },
    key,
    ownedBytes(data)
  ));
  const out = new Uint8Array(header.byteLength + ciphertext.byteLength);
  out.set(header, 0);
  out.set(ciphertext, header.byteLength);
  return out;
}

export async function encryptBackupBlob(blob: Blob, password: string, opts: { iterations?: number } = {}) {
  const wrapped = await encryptBackupBytes(new Uint8Array(await blob.arrayBuffer()), password, opts);
  return new Blob([wrapped], { type: 'application/octet-stream' });
}

export async function decryptBackupBytes(wrapped: Uint8Array, password: string) {
  checkPassword(password);
  if (wrapped.byteLength < HEADER_BYTES + TAG_BYTES || !isEncryptedBackupBytes(wrapped)) {
    throw new BackupCryptoError('backup-encrypted-unsupported');
  }
  if (wrapped[8] !== KDF_PBKDF2_SHA256) {
    throw new BackupCryptoError('backup-encrypted-unsupported');
  }
  const iterations = new DataView(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength).getUint32(9, false);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new BackupCryptoError('backup-encrypted-unsupported');
  }
  const header = wrapped.subarray(0, HEADER_BYTES);
  const salt = wrapped.subarray(13, 29);
  const nonce = wrapped.subarray(29, 41);
  const ciphertext = wrapped.subarray(HEADER_BYTES);
  const key = await deriveKey(password, salt, iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ownedBytes(nonce), additionalData: ownedBytes(header), tagLength: TAG_BYTES * 8 },
      key,
      ownedBytes(ciphertext)
    );
    return new Uint8Array(plain);
  } catch {
    throw new BackupCryptoError('backup-decrypt-failed');
  }
}
