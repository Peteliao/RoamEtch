import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncService } from '../src/core/syncService';

beforeEach(async () => {
  await syncService.erase();
});

afterEach(async () => {
  await syncService.erase();
});

describe('SyncService contract', () => {
  it('loads a stable device identity and exposes its fingerprint', async () => {
    const identity = await syncService.loadIdentity('Contract device');
    expect(identity.name).toBe('Contract device');
    expect(identity.deviceId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const fingerprint = await syncService.fingerprint(identity);
    expect(fingerprint).toMatch(/^[A-Za-z0-9 :]{8,}$/);

    const again = await syncService.loadIdentity();
    expect(again.deviceId).toBe(identity.deviceId);
    expect(again.name).toBe('Contract device');

    const renamed = await syncService.renameIdentity(identity, 'Renamed');
    expect(renamed.name).toBe('Renamed');
    expect((await syncService.loadIdentity()).name).toBe('Renamed');
  });

  it('creates, parses and verifies pairing invites as one boundary', async () => {
    const identity = await syncService.loadIdentity('Host');
    const invite = await syncService.createInvite(identity, { ttlMs: 120_000, name: 'Host' });
    expect(invite.code.startsWith('RMS1.')).toBe(true);

    const parsed = syncService.parseInvite(invite.code);
    expect(parsed).not.toBeNull();
    expect(await syncService.verifyInvite(parsed!)).toBe(true);
    expect(syncService.parseInvite('not-an-invite')).toBeNull();
    expect(syncService.isSelfInvite(parsed!, identity)).toBe(true);
    expect(await syncService.hostFingerprint(parsed!)).toBe(await syncService.fingerprint(identity));
  });

  it('reports summary state and resets peer identity without touching trip data', async () => {
    const identity = await syncService.loadIdentity('Reset me');
    expect(await syncService.listPeers()).toEqual([]);
    expect(await syncService.summary()).toMatchObject({ records: 0, tombstones: 0, peers: [] });

    await syncService.erase();
    const next = await syncService.loadIdentity('New identity');
    expect(next.deviceId).not.toBe(identity.deviceId);
    expect(await syncService.listPeers()).toEqual([]);
  });
});
