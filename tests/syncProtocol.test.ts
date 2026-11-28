import { describe, expect, it } from 'vitest';
import {
  digestLedger, pageManifest, parseSyncWire, remoteWins,
  syncRecordData, syncRecordHash, validateRemoteRow,
  type SyncLedgerEntry
} from '../src/core/syncProtocol';

function ledger(overrides: Partial<SyncLedgerEntry> = {}): SyncLedgerEntry {
  return {
    key: 'trips:trip-1', table: 'trips', id: 'trip-1', hash: 'a'.repeat(64),
    stamp: 100, deviceId: 'dev-aaaaaa', deleted: false, cursor: 1, at: 1,
    ...overrides
  };
}

describe('sync record hashing', () => {
  it('is deterministic and ignores derived trip fields', async () => {
    const a = await syncRecordHash('trips', {
      id: 'trip-1', name: 'A', updatedAt: 10, statsCache: { distance: 1 }, thumbPoints: [1], reportedDistance: 5
    });
    const b = await syncRecordHash('trips', {
      reportedDistance: null, thumbPoints: null, name: 'A', id: 'trip-1', updatedAt: 10, statsCache: null
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('changes when a real field changes', async () => {
    const a = await syncRecordHash('trips', { id: 'trip-1', name: 'A', updatedAt: 10 });
    const b = await syncRecordHash('trips', { id: 'trip-1', name: 'B', updatedAt: 10 });
    expect(a).not.toBe(b);
  });

  it('includes media blob hashes and sizes without the binary itself', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const thumb = new Blob([new Uint8Array([9])], { type: 'image/webp' });
    const row = { id: 'media-1', tripId: 'trip-1', blob, thumb, width: 10, height: 20, createdAt: 5 };
    const data = syncRecordData('media', row, { blobHash: 'b'.repeat(64), thumbHash: 'c'.repeat(64) });
    expect(data.blob).toBeUndefined();
    expect(data.thumb).toBeUndefined();
    expect(data.blobSize).toBe(3);
    expect(data.thumbSize).toBe(1);
    const hash = await syncRecordHash('media', row, { blobHash: 'b'.repeat(64), thumbHash: 'c'.repeat(64) });
    expect(hash).toBe(await syncRecordHash('media', row, { blobHash: 'b'.repeat(64), thumbHash: 'c'.repeat(64) }));
    expect(hash).not.toBe(await syncRecordHash('media', row, { blobHash: 'd'.repeat(64), thumbHash: 'c'.repeat(64) }));
  });
});

describe('sync version ordering', () => {
  it('prefers newer stamps, then device id, then tombstones deterministically', () => {
    const newer = { st: 20, dev: 'dev-aaaaaa', h: 'a'.repeat(64) };
    const older = { st: 10, dev: 'dev-zzzzzz', h: 'b'.repeat(64) };
    expect(remoteWins(newer, older)).toBe(true);
    expect(remoteWins(older, newer)).toBe(false);
    expect(remoteWins({ st: 10, dev: 'dev-bbbbbb', h: 'a'.repeat(64) }, { ...older, dev: 'dev-aaaaaa' })).toBe(true);
    expect(remoteWins({ st: 10, dev: 'dev-aaaaaa', h: 'a'.repeat(64) }, { ...older, dev: 'dev-bbbbbb' })).toBe(false);
    const tombstone = { st: 10, dev: 'dev-zzzzzz', h: '', del: true };
    expect(remoteWins(tombstone, older)).toBe(true);
    expect(remoteWins(older, tombstone)).toBe(false);
    expect(remoteWins({ ...older }, { ...older })).toBe(false);
  });

  it('compares ledger entries through their readable fields', () => {
    const local = ledger({ stamp: 20, deviceId: 'dev-bbbbbb' });
    expect(remoteWins({ st: 10, dev: 'dev-aaaaaa', h: 'b'.repeat(64) }, local)).toBe(false);
    expect(remoteWins({ st: 21, dev: 'dev-aaaaaa', h: 'b'.repeat(64) }, local)).toBe(true);
  });
});

describe('sync manifests and digests', () => {
  it('pages by cursor, honours since, and is order-independent for the digest', async () => {
    const entries = [
      ledger({ key: 'trips:trip-1', id: 'trip-1', cursor: 2 }),
      ledger({ key: 'trips:trip-2', id: 'trip-2', cursor: 9, hash: 'b'.repeat(64) }),
      ledger({ key: 'waypoints:wp-1', table: 'waypoints', id: 'wp-1', cursor: 4, hash: 'c'.repeat(64) })
    ];
    const pages = pageManifest(entries, 3, 1);
    expect(pages).toHaveLength(2);
    expect(pages[0][0].id).toBe('wp-1');
    expect(pages[1][0].id).toBe('trip-2');
    expect(pageManifest(entries, 9)[0]).toHaveLength(0);
    const digestA = await digestLedger(entries);
    const digestB = await digestLedger([...entries].reverse());
    expect(digestA).toBe(digestB);
    expect(await digestLedger(entries.map((entry, index) => index === 0 ? { ...entry, deleted: true, hash: '' } : entry)))
      .not.toBe(digestA);
  });

  it('rejects malformed wire messages and unknown protocol versions', () => {
    expect(() => parseSyncWire('{')).toThrow('sync-message');
    expect(() => parseSyncWire(JSON.stringify({ type: 'hello', pv: 2, deviceId: 'dev-aaaaaa', name: 'A' }))).toThrow('sync-version');
    expect(parseSyncWire(JSON.stringify({
      type: 'want', keys: [{ t: 'trips', id: 'trip-1' }, { t: 'trips', id: 'trip-1' }]
    }))).toEqual({ type: 'want', keys: [{ t: 'trips', id: 'trip-1' }] });
    expect(() => parseSyncWire(JSON.stringify({
      type: 'want', keys: [{ t: 'secrets', id: 'x' }]
    }))).toThrow('sync-message');
    expect(() => parseSyncWire(JSON.stringify({
      type: 'record', record: { t: 'trips', id: 'trip-1', h: 'bad', data: { id: 'trip-1' } }
    }))).toThrow('sync-verify');
    const complete = {
      type: 'complete', digest: 'a'.repeat(64), through: 4, applied: 1, received: 2, sent: 3
    };
    expect(parseSyncWire(JSON.stringify({ ...complete, ack: true }))).toEqual({ ...complete, ack: true });
    expect(() => parseSyncWire(JSON.stringify({ ...complete, ack: false }))).toThrow('sync-message');
  });
});

describe('remote row validation', () => {
  it('accepts core records and rejects invalid coordinates and oversized chunks', () => {
    expect(validateRemoteRow('trips', { id: 'trip-1', name: 'A', status: 'finished', updatedAt: 10 })).toBeNull();
    expect(validateRemoteRow('trips', { id: 'trip-1', name: 'A', status: 'recording', updatedAt: 10 })).toBeNull();
    expect(validateRemoteRow('trackChunks', {
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0,
      points: [{ lat: 91, lon: 0 }]
    })).toBe('point');
    expect(validateRemoteRow('trackChunks', {
      id: 'chunk-1', tripId: 'trip-1', segmentId: 'seg-1', seq: 0,
      points: Array.from({ length: 2001 }, () => ({ lat: 1, lon: 1 }))
    })).toBe('points');
    expect(validateRemoteRow('waypoints', { id: 'wp-1', tripId: 'trip-1', lat: 30, lon: 120, mediaIds: ['m-1'] })).toBeNull();
    expect(validateRemoteRow('media', { id: 'm-1', tripId: 'trip-1', width: 1, height: 1, createdAt: 1 })).toBeNull();
  });
});

