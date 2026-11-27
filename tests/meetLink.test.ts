import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptMeetPacket,
  deriveMeetRoom,
  encryptMeetPacket,
  generateMeetInvite,
  isLegacyMeetCode,
  meetLinkFor,
  MEET_INVITE_MAX_TTL_MS,
  MEET_MAX_PACKET_CHARS,
  normalizeMeetInvite,
  parseMeetFragment,
  parseMeetInvite,
  parseMeetLink,
  roomLabelFor,
  signMeetInviteExpiry,
  verifyMeetInviteExpiry
} from '../src/core/meetLink';

function b64urlEncode(u8: Uint8Array) {
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string) {
  const body = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function envelope(text: string) {
  const bytes = b64urlDecode(text);
  return { version: bytes[0], iv: bytes.slice(1, 13), cipher: bytes.slice(13), bytes };
}

function reencode(bytes: Uint8Array) {
  return b64urlEncode(bytes);
}

const DEMO_ROOM = b64urlEncode(new Uint8Array(16).fill(0xab));
const DEMO_SECRET = b64urlEncode(new Uint8Array(32).fill(0xcd));
const DEMO_INVITE = `TM2.${DEMO_ROOM}.${DEMO_SECRET}`;

afterEach(() => vi.unstubAllGlobals());

describe('meetup invites', () => {
  it('generates a versioned 128-bit room id and 256-bit secret', () => {
    const invites = new Set(Array.from({ length: 50 }, () => generateMeetInvite()));
    expect(invites.size).toBe(50);
    for (const invite of invites) {
      expect(invite).toMatch(/^TM2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
      const parts = parseMeetInvite(invite);
      expect(parts?.roomId).toHaveLength(22);
      expect(parts?.secret).toHaveLength(32);
    }
  });

  it('accepts canonical tokens, invite links and whitespace, but not v1 codes', () => {
    expect(normalizeMeetInvite(DEMO_INVITE)).toBe(DEMO_INVITE);
    expect(normalizeMeetInvite(`  ${DEMO_INVITE.slice(0, 20)}\n${DEMO_INVITE.slice(20)}  `)).toBe(DEMO_INVITE);
    expect(normalizeMeetInvite(`https://example.com/RoamEtch/#meet=${DEMO_INVITE}`)).toBe(DEMO_INVITE);
    expect(normalizeMeetInvite(`#meet=${DEMO_INVITE}`)).toBe(DEMO_INVITE);
    expect(normalizeMeetInvite(DEMO_INVITE.toLowerCase())).toBe('');
    expect(normalizeMeetInvite('ABCD-EFGH-JKMN')).toBe('');
    expect(normalizeMeetInvite('TM2.too-short.too-short')).toBe('');
  });

  it('detects only the retired 12-character Crockford format', () => {
    expect(isLegacyMeetCode('ABCD-EFGH-JKMN')).toBe(true);
    expect(isLegacyMeetCode('#meet=abcd efgh jkmn')).toBe(true);
    expect(isLegacyMeetCode(DEMO_INVITE)).toBe(false);
    expect(isLegacyMeetCode('too-short')).toBe(false);
  });

  it('builds and parses fragment invites without lowering the secret', () => {
    vi.stubGlobal('location', {
      origin: 'https://example.com',
      pathname: '/RoamEtch/',
      search: '?x=1'
    });
    const link = meetLinkFor(DEMO_INVITE);
    expect(link).toBe(`https://example.com/RoamEtch/?x=1#meet=${DEMO_INVITE}`);
    expect(parseMeetFragment(`#meet=${DEMO_INVITE}`)).toBe(DEMO_INVITE);
    expect(parseMeetFragment(`#meet=${encodeURIComponent(DEMO_INVITE)}`)).toBe(DEMO_INVITE);
    expect(parseMeetFragment('#meet=ABCD-EFGH-JKMN')).toBe('');
    expect(parseMeetFragment('#meet=bad')).toBe('');
    expect(parseMeetFragment('#t=abc')).toBe('');
  });

  it('derives a public room label without exposing the secret', () => {
    expect(roomLabelFor('abcdefghijklmnopqrstuv')).toBe('ABCD-EFGH');
  });

  it('signs and verifies a invite lifetime independently from the session', async () => {
    const now = Date.UTC(2026, 10, 27, 8, 0, 0);
    const exp = now + 6 * 60 * 60_000;
    const sig = await signMeetInviteExpiry(DEMO_INVITE, exp);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, exp, sig, now)).resolves.toEqual({
      ok: true, legacy: false, expiresAt: exp
    });
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, 0, '', now)).resolves.toEqual({
      ok: true, legacy: true, expiresAt: 0
    });

    const otherInvite = `TM2.${DEMO_ROOM}.${b64urlEncode(new Uint8Array(32).fill(0x11))}`;
    const badSig = `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`;
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, exp, badSig, now))
      .resolves.toEqual({ ok: false, reason: 'signature' });
    await expect(verifyMeetInviteExpiry(otherInvite, exp, sig, now))
      .resolves.toEqual({ ok: false, reason: 'signature' });
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, exp, sig, exp))
      .resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, now + MEET_INVITE_MAX_TTL_MS + 1, sig, now))
      .resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(verifyMeetInviteExpiry(DEMO_INVITE, exp, 'bad', now))
      .resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('appends optional signed expiry parameters and parses them from links', () => {
    vi.stubGlobal('location', {
      origin: 'https://example.com',
      pathname: '/RoamEtch/',
      search: ''
    });
    const exp = Date.UTC(2026, 10, 28);
    const sig = b64urlEncode(new Uint8Array(32).fill(0x7e));
    const link = meetLinkFor(DEMO_INVITE, { exp, sig });
    expect(link).toBe(`https://example.com/RoamEtch/#meet=${DEMO_INVITE}&iexp=${exp}&isig=${sig}`);
    expect(parseMeetLink(link)).toEqual({ invite: DEMO_INVITE, exp, sig });
    expect(parseMeetLink(`#meet=${DEMO_INVITE}`)).toEqual({ invite: DEMO_INVITE, exp: 0, sig: '' });
    expect(parseMeetLink(DEMO_INVITE)).toEqual({ invite: DEMO_INVITE, exp: 0, sig: '' });
    expect(parseMeetLink(`#meet=${DEMO_INVITE}&iexp=0&isig=bad`))
      .toEqual({ invite: DEMO_INVITE, exp: 0, sig: '' });
  });
});

describe('meetup key derivation', () => {
  it('derives AES-256-GCM from the secret and binds the room id as AAD', async () => {
    const room = await deriveMeetRoom(DEMO_INVITE);
    expect(room.invite).toBe(DEMO_INVITE);
    expect(room.roomId).toBe(DEMO_ROOM);
    expect((room.key.algorithm as AesKeyAlgorithm).length).toBe(256);
    expect(room.noncePrefix).toHaveLength(8);
    expect(room.nonceCounter).toBe(0n);

    const otherSecret = `TM2.${DEMO_ROOM}.${b64urlEncode(new Uint8Array(32).fill(0x11))}`;
    const other = await deriveMeetRoom(otherSecret);
    expect(other.roomId).toBe(room.roomId);
    const cipher = await encryptMeetPacket({ v: 2, k: 'loc', id: 'peer-a' }, room);
    expect(await decryptMeetPacket(cipher, room)).toEqual({ v: 2, k: 'loc', id: 'peer-a' });
    expect(await decryptMeetPacket(cipher, other)).toBeNull();
  });

  it('rejects legacy and malformed invitations with distinct errors', async () => {
    await expect(deriveMeetRoom('ABCD-EFGH-JKMN')).rejects.toThrow('legacy-meet-invite');
    await expect(deriveMeetRoom('not-an-invite')).rejects.toThrow('invalid-meet-invite');
  });
});

describe('AES-256-GCM meetup packets', () => {
  it('rejects tampering, a wrong room, v1 envelopes, and malformed input', async () => {
    const room = await deriveMeetRoom(DEMO_INVITE);
    const other = await deriveMeetRoom(generateMeetInvite());
    const packet = { v: 2, k: 'loc', id: 'peer-a', la: 39.9, lo: 116.4, sq: 1 };
    const cipher = await encryptMeetPacket(packet, room);
    expect(await decryptMeetPacket(cipher, room)).toEqual(packet);

    const raw = envelope(cipher);
    const tampered = new Uint8Array(raw.bytes);
    tampered[20] ^= 0x01;
    expect(await decryptMeetPacket(reencode(tampered), room)).toBeNull();

    const v1 = new Uint8Array(raw.bytes);
    v1[0] = 1;
    expect(await decryptMeetPacket(reencode(v1), room)).toBeNull();
    expect(await decryptMeetPacket(cipher, other)).toBeNull();
    expect(await decryptMeetPacket('short', room)).toBeNull();
  });

  it('round-trips a full 56 KB chat image above the retired 8 KB limit', async () => {
    const room = await deriveMeetRoom(DEMO_INVITE);
    const bytes = new Uint8Array(56 * 1024).fill(0x5a);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const packet = { v: 2, k: 'msg', id: 'peer-a', sq: 1, im: btoa(binary), imt: 'image/webp', imw: 720, imh: 480 };
    const cipher = await encryptMeetPacket(packet, room);
    expect(cipher.length).toBeGreaterThan(8192);
    expect(cipher.length).toBeLessThanOrEqual(MEET_MAX_PACKET_CHARS);
    expect(await decryptMeetPacket(cipher, room)).toEqual(packet);
    expect(await decryptMeetPacket('A'.repeat(MEET_MAX_PACKET_CHARS + 1), room)).toBeNull();
  });

  it('uses a unique per-device nonce prefix and monotonic counter', async () => {
    const room = await deriveMeetRoom(DEMO_INVITE);
    const seen = new Set<string>();
    for (let i = 0; i < 257; i++) {
      const cipher = await encryptMeetPacket({ v: 2, sq: i + 1 }, room);
      const raw = envelope(cipher);
      expect(raw.version).toBe(2);
      expect(raw.iv.slice(0, 8)).toEqual(room.noncePrefix);
      const counter = ((raw.iv[8] << 24) | (raw.iv[9] << 16) | (raw.iv[10] << 8) | raw.iv[11]) >>> 0;
      expect(counter).toBe(i);
      seen.add(b64urlEncode(raw.iv));
    }
    expect(seen.size).toBe(257);
    expect(room.nonceCounter).toBe(257n);

    const other = await deriveMeetRoom(DEMO_INVITE);
    expect(other.noncePrefix).not.toEqual(room.noncePrefix);
  });
});
