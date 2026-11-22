import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { sha256Hex, stableStringify } from '../src/core/integrity';

vi.mock('../src/core/store', () => ({
  db: {
    trips: { toArray: async () => [{ id: 't1', name: 'Test trip' }] },
    segments: { toArray: async () => [{ id: 's1', tripId: 't1', index: 0, points: [] }] },
    trackChunks: { toArray: async () => [] },
    waypoints: { toArray: async () => [] },
    media: { toArray: async () => [{ id: 'm1', tripId: 't1', blob: new Blob([new Uint8Array([1, 2, 3])]) }] },
    elevCache: { toArray: async () => [] }
  },
  deleteTrip: vi.fn()
}));
vi.mock('../src/core/events', () => ({ emit: vi.fn() }));

const { exportBackup, inspectBackup } = await import('../src/core/backup');

function asFile(blob) {
  return { arrayBuffer: () => blob.arrayBuffer() };
}

describe('backup integrity', () => {
  it('stable-stringifies objects independent of key order', async () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(await sha256Hex('abc')).toHaveLength(64);
  });

  it('exports a checksummed archive that verifies', async () => {
    const backup = await exportBackup();
    expect(backup.tripCount).toBe(1);
    const inspected = await inspectBackup(asFile(backup.blob));
    expect(inspected.manifest.version).toBe(2);
    expect(inspected.integrity.ok).toBe(true);
    expect(inspected.integrity.checked).toBe(1);
    expect(inspected.manifest.counts.media).toBe(1);
  });

  it('detects a modified manifest', async () => {
    const backup = await exportBackup();
    const files = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(files['manifest.json']));
    manifest.trips[0].name = 'tampered';
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    const tampered = new Blob([zipSync(files)]);
    const inspected = await inspectBackup(asFile(tampered));
    expect(inspected.integrity.ok).toBe(false);
    expect(inspected.integrity.failed).toContain('manifest');
  });

  it('detects modified media bytes', async () => {
    const backup = await exportBackup();
    const files = unzipSync(new Uint8Array(await backup.blob.arrayBuffer()));
    files['media/m1.jpg'] = new Uint8Array([9, 9, 9]);
    const tampered = new Blob([zipSync(files)]);
    const inspected = await inspectBackup(asFile(tampered));
    expect(inspected.integrity.ok).toBe(false);
    expect(inspected.integrity.failed).toContain('media/m1.jpg');
  });

  it('rejects malformed manifests before restore', async () => {
    const manifest = {
      format: 'localtrace-backup', version: 2,
      exportedAt: new Date().toISOString(),
      counts: { trips: 0 },
      trips: [], segments: [], trackChunks: [], waypoints: []
    };
    const malformed = new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })]);
    await expect(inspectBackup(asFile(malformed))).rejects.toThrow('invalid manifest');
  });

  it('accepts legacy version 1 backups without a checksum', async () => {
    const manifest = {
      format: 'localtrace-backup', version: 1,
      exportedAt: new Date().toISOString(),
      counts: { trips: 0 },
      trips: [], segments: [], trackChunks: [], waypoints: [], mediaMeta: [], elevCache: []
    };
    const legacy = new Blob([zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)) })]);
    const inspected = await inspectBackup(asFile(legacy));
    expect(inspected.integrity.ok).toBe(null);
    expect(inspected.conflicts).toEqual([]);
  });
});
