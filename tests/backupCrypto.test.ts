import { describe, expect, it } from 'vitest';
import {
  BackupCryptoError,
  decryptBackupBytes,
  encryptBackupBytes,
  isEncryptedBackupBytes,
  isEncryptedBackupFile
} from '../src/core/backupCrypto';

const data = new TextEncoder().encode('PK\u0003\u0004 private track payload');
const password = 'correct horse battery';

function expectCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({ code });
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

describe('encrypted backup envelope', () => {
  it('round-trips the archive and never stores plaintext in the envelope', async () => {
    const wrapped = await encryptBackupBytes(data, password, { iterations: 100_000 });
    expect(isEncryptedBackupBytes(wrapped)).toBe(true);
    expect(new TextDecoder().decode(wrapped.subarray(0, 8))).toBe('TRKMBKP1');
    expect(containsBytes(wrapped, data)).toBe(false);
    const plain = await decryptBackupBytes(wrapped, password);
    expect([...plain]).toEqual([...data]);
    const fresh = await encryptBackupBytes(data, password, { iterations: 100_000 });
    expect([...fresh.subarray(13, 29)]).not.toEqual([...wrapped.subarray(13, 29)]);
  });

  it('rejects missing, weak and wrong passwords', async () => {
    await expectCode(encryptBackupBytes(data, ''), 'backup-password-required');
    await expectCode(encryptBackupBytes(data, 'short'), 'backup-password-weak');
    const wrapped = await encryptBackupBytes(data, password, { iterations: 100_000 });
    await expectCode(decryptBackupBytes(wrapped, 'wrong password'), 'backup-decrypt-failed');
    await expectCode(decryptBackupBytes(wrapped, ''), 'backup-password-required');
  });

  it('authenticates the header and rejects unsupported work factors', async () => {
    const wrapped = await encryptBackupBytes(data, password, { iterations: 100_000 });
    const tampered = wrapped.slice();
    tampered[20] ^= 0xff;
    await expectCode(decryptBackupBytes(tampered, password), 'backup-decrypt-failed');

    const wrongKdf = wrapped.slice();
    wrongKdf[8] = 9;
    await expectCode(decryptBackupBytes(wrongKdf, password), 'backup-encrypted-unsupported');

    const huge = wrapped.slice();
    new DataView(huge.buffer).setUint32(9, 5_000_000, false);
    await expectCode(decryptBackupBytes(huge, password), 'backup-encrypted-unsupported');
    await expectCode(decryptBackupBytes(new Uint8Array(20), password), 'backup-encrypted-unsupported');
  });

  it('detects the envelope from a small file prefix', async () => {
    const wrapped = await encryptBackupBytes(data, password, { iterations: 100_000 });
    const file = new Blob([wrapped]);
    expect(await isEncryptedBackupFile(file)).toBe(true);
    expect(await isEncryptedBackupFile(new Blob([new Uint8Array([1, 2, 3])]))).toBe(false);
    expect(await isEncryptedBackupFile({ size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer })).toBe(false);
  });

  it('exposes a typed error for UI prompts', () => {
    const err = new BackupCryptoError('backup-decrypt-failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('backup-decrypt-failed');
  });
});
