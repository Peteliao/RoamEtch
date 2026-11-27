import { describe, expect, it } from 'vitest';
import {
  b64urlEncode, createDeviceIdentity, createSyncHello, createSyncInvite, deriveSyncSignalKey,
  deviceIdForPublicJwk, fingerprintForPublicJwk, openSyncSignal, parseSyncInvite, sealSyncSignal,
  signSyncText, verifySyncHello, verifySyncInvite, verifySyncText
} from '../src/core/syncIdentity';

describe('sync device identity', () => {
  it('derives a stable device id and signs data', async () => {
    const identity = await createDeviceIdentity('Alice phone');
    expect(identity.deviceId).toMatch(/^dev-[A-Za-z0-9_-]{6,40}$/);
    expect(identity.deviceId).toBe(await deviceIdForPublicJwk(identity.publicJwk));
    expect(identity.name).toBe('Alice phone');
    expect(await fingerprintForPublicJwk(identity.publicJwk)).toMatch(/^[0-9A-F]{4} [0-9A-F]{4} [0-9A-F]{4}$/);
    const signature = await signSyncText(identity, 'hello');
    expect(await verifySyncText(identity.publicJwk, 'hello', signature)).toBe(true);
    expect(await verifySyncText(identity.publicJwk, 'hello!', signature)).toBe(false);
  });
});

describe('sync pairing invite', () => {
  it('round-trips and validates the device key', async () => {
    const identity = await createDeviceIdentity('Alice');
    const invite = await createSyncInvite(identity, { ttlMs: 5 * 60_000 });
    expect(invite.code.startsWith('RMS1.')).toBe(true);
    const parsed = parseSyncInvite(invite.code);
    expect(parsed?.room).toBe(invite.room);
    expect(parsed?.deviceId).toBe(identity.deviceId);
    expect(parsed?.secret).toBe(invite.secret);
    expect(await verifySyncInvite(parsed)).toBe(true);
    expect(await verifySyncInvite({ ...parsed!, deviceId: 'dev-not-the-right-key' })).toBe(false);
  });

  it('rejects expired or oversized pairing codes', async () => {
    const identity = await createDeviceIdentity('Alice');
    const invite = await createSyncInvite(identity, { ttlMs: 60_000 });
    expect(parseSyncInvite(invite.code, invite.exp + 1)).toBeNull();
    expect(parseSyncInvite('not-a-code')).toBeNull();
    expect(parseSyncInvite(invite.code.repeat(10))).toBeNull();
  });
});

describe('encrypted signaling', () => {
  it('seals a hello so only the QR secret holder can open it', async () => {
    const alice = await createDeviceIdentity('Alice');
    const bob = await createDeviceIdentity('Bob');
    const invite = await createSyncInvite(alice, { ttlMs: 60_000 });
    const key = await deriveSyncSignalKey(invite);
    const otherKey = await deriveSyncSignalKey({ ...invite, secret: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))) });
    const body = { kind: 'sync-hello', room: invite.room, n: 1 };
    const sealed = await sealSyncSignal(key, body);
    expect(sealed).not.toContain('sync-hello');
    expect(await openSyncSignal(key, sealed)).toEqual(body);
    expect(await openSyncSignal(otherKey, sealed)).toBeNull();
    expect(await openSyncSignal(key, sealed.slice(0, -4))).toBeNull();
    const hello = await createSyncHello(bob, invite, 'responder');
    const verified = await verifySyncHello(invite, hello, 'responder');
    expect(verified?.deviceId).toBe(bob.deviceId);
    expect(verified?.name).toBe('Bob');
    expect(await verifySyncHello(invite, hello, 'initiator')).toBeNull();
    expect(await verifySyncHello(invite, { ...hello, name: 'Mallory' }, 'responder')).toBeNull();
    expect(await verifySyncHello(invite, { ...hello, at: hello.at - 10 * 60_000 }, 'responder')).toBeNull();
  });
});
