import { describe, expect, it } from 'vitest';
import {
  deriveMeetEpochKey,
  deriveMeetPairwiseKey,
  generateEpochSecret,
  generateMeetKeyPair,
  importMeetPublicKey,
  meetLocationPlan,
  meetRoomWithKey,
  negotiateMeetProtocol,
  openMeetDirect,
  sealMeetDirect,
  epochSecretB64,
  decodeEpochSecret,
  MEET_EPOCH_SECRET_BYTES,
  MEET_PROTOCOL_MAX,
  MEET_PROTOCOL_MIN
} from '../src/core/meetKeys';

const ROOM = 'room-abcdefghijklmnopqrstuv';

describe('meet protocol negotiation', () => {
  it('accepts overlapping ranges and rejects old, new or missing ranges explicitly', () => {
    expect(negotiateMeetProtocol(2, 5, 4)).toEqual({ ok: true, version: 4 });
    expect(negotiateMeetProtocol(MEET_PROTOCOL_MIN, MEET_PROTOCOL_MAX, 4))
      .toEqual({ ok: true, version: MEET_PROTOCOL_MAX });
    expect(negotiateMeetProtocol(2, 2, 2)).toMatchObject({ ok: false, reason: 'old' });
    expect(negotiateMeetProtocol(4, 6, 5)).toMatchObject({ ok: false, reason: 'new' });
    expect(negotiateMeetProtocol(undefined, 3, 3)).toMatchObject({ ok: false, reason: 'missing' });
    expect(negotiateMeetProtocol(4, 3, 3)).toMatchObject({ ok: false, reason: 'missing' });
  });
});

describe('meet pairwise ECDH channel', () => {
  it('derives the same key on both sides and rejects a third key', async () => {
    const alice = await generateMeetKeyPair();
    const bob = await generateMeetKeyPair();
    const eve = await generateMeetKeyPair();
    const alicePub = (await importMeetPublicKey(bob.publicB64))!;
    const bobPub = (await importMeetPublicKey(alice.publicB64))!;
    expect(alicePub).not.toBeNull();
    expect(bobPub).not.toBeNull();

    const aKey = await deriveMeetPairwiseKey(alice.privateKey, alicePub, ROOM, 'alice', 'bob');
    const bKey = await deriveMeetPairwiseKey(bob.privateKey, bobPub, ROOM, 'bob', 'alice');
    const eKey = await deriveMeetPairwiseKey(eve.privateKey, bobPub, ROOM, 'eve', 'alice');

    const box = await sealMeetDirect(aKey, { v: 2, k: 'loc', la: 31 });
    expect(await openMeetDirect(bKey, box)).toEqual({ v: 2, k: 'loc', la: 31 });
    expect(await openMeetDirect(eKey, box)).toBeNull();
    expect(await openMeetDirect(aKey, `${box.slice(0, -2)}${box.endsWith('A') ? 'B' : 'A'}`)).toBeNull();
    expect(await openMeetDirect(aKey, 'not-a-box')).toBeNull();
  });

  it('rejects malformed public keys and outsider keys', async () => {
    expect(await importMeetPublicKey('short')).toBeNull();
    expect(await importMeetPublicKey('A'.repeat(87))).toBeNull();
    const alice = await generateMeetKeyPair();
    const bob = await generateMeetKeyPair();
    const bobPub = (await importMeetPublicKey(bob.publicB64))!;
    const otherPub = (await importMeetPublicKey(alice.publicB64))!;
    const inRoom = await deriveMeetPairwiseKey(alice.privateKey, bobPub, ROOM, 'alice', 'bob');
    const other = await deriveMeetPairwiseKey(
      (await generateMeetKeyPair()).privateKey, otherPub, ROOM, 'alice', 'bob'
    );
    const box = await sealMeetDirect(inRoom, { k: 'x' });
    expect(await openMeetDirect(other, box)).toBeNull();
  });
});

describe('meet epoch secrets', () => {
  it('derives distinct AES-GCM keys per epoch with a fresh nonce prefix', async () => {
    const secret = generateEpochSecret();
    expect(secret).toHaveLength(MEET_EPOCH_SECRET_BYTES);
    expect(decodeEpochSecret(epochSecretB64(secret))).toEqual(secret);
    expect(decodeEpochSecret('short')).toBeNull();
    const key1 = await deriveMeetEpochKey(ROOM, 1, secret);
    const key2 = await deriveMeetEpochKey(ROOM, 2, secret);
    expect(key1).not.toBe(key2);
    expect((key1.algorithm as AesKeyAlgorithm).length).toBe(256);
    await expect(deriveMeetEpochKey(ROOM, 0, secret)).rejects.toThrow('invalid-meet-epoch');
    await expect(deriveMeetEpochKey(ROOM, 1, new Uint8Array(8))).rejects.toThrow('invalid-meet-epoch');

    const room: any = {
      invite: 'x', roomId: ROOM, key: key1,
      noncePrefix: new Uint8Array(8), nonceCounter: 7n
    };
    const rotated = meetRoomWithKey(room, key2);
    expect(rotated.key).toBe(key2);
    expect(rotated.roomId).toBe(ROOM);
    expect(rotated.noncePrefix).not.toEqual(room.noncePrefix);
    expect(rotated.noncePrefix).toHaveLength(8);
    expect(rotated.noncePrefix).not.toEqual(new Uint8Array(8));
    expect(rotated.nonceCounter).toBe(0n);
  });
});

describe('per-peer location visibility plan', () => {
  it('broadcasts only while every peer is visible and otherwise targets visible peers', () => {
    const all = new Map([['a', 'full' as const], ['b', 'full' as const]]);
    expect(meetLocationPlan(['a', 'b'], all, new Set())).toEqual({
      mode: 'broadcast', targets: [], hidden: 0
    });
    const mixed = new Map([['a', 'full' as const], ['b', 'hidden' as const]]);
    expect(meetLocationPlan(['a', 'b'], mixed, new Set(['a']))).toEqual({
      mode: 'direct', targets: ['a'], hidden: 1
    });
    expect(meetLocationPlan(['a', 'b'], mixed, new Set())).toEqual({
      mode: 'direct', targets: [], hidden: 1
    });
    expect(meetLocationPlan([], mixed, new Set())).toEqual({
      mode: 'none', targets: [], hidden: 0
    });
  });
});
