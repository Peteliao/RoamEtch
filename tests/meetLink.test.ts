import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decryptMeetPacket,
  deriveMeetRoom,
  encryptMeetPacket,
  formatMeetCode,
  generateMeetCode,
  meetLinkFor,
  normalizeMeetCode,
  parseMeetFragment
} from '../src/core/meetLink';

afterEach(() => vi.unstubAllGlobals());

describe('meetup codes', () => {
  it('normalises Crockford-style input', () => {
    expect(normalizeMeetCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normalizeMeetCode('OILU-0000-0000')).toBe('011V00000000');
    expect(normalizeMeetCode('too-short')).toBe('');
    expect(formatMeetCode('ABCDEFGHJKMN')).toBe('ABCD-EFGH-JKMN');
  });

  it('generates high-entropy codes from the unambiguous alphabet', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateMeetCode()));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/);
  });
});

describe('meetup key derivation', () => {
  it('derives the relay room id from a domain-separated digest, not the code', async () => {
    const code = 'ABCDEFGHJKMN';
    const room = await deriveMeetRoom(code);
    const expected = new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`trackmint-meet-code:${code}`)
    ));
    const expectedHex = [...expected.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(room.roomId).toBe(expectedHex);
    expect(room.roomId).not.toContain(code);
    expect(room.roomId).toHaveLength(32);
  });

  it('is deterministic per code and isolated across codes', async () => {
    const a = await deriveMeetRoom('ABCDEFGHJKMN');
    const b = await deriveMeetRoom('abcd efgh jkmn');
    const c = await deriveMeetRoom('ABCDEFGHJKMP');
    expect(b.roomId).toBe(a.roomId);
    expect(c.roomId).not.toBe(a.roomId);
  });
});

describe('AES-GCM meetup packets', () => {
  it('round-trips a packet and rejects tampering or a wrong room', async () => {
    const room = await deriveMeetRoom('ABCDEFGHJKMN');
    const other = await deriveMeetRoom('ABCDEFGHJKMP');
    const packet = { v: 1, k: 'loc', id: 'peer-a', la: 39.9, lo: 116.4, ts: Date.now() };
    const cipher = await encryptMeetPacket(packet, room);
    expect(await decryptMeetPacket(cipher, room)).toEqual(packet);

    const at = Math.floor(cipher.length / 2);
    const tampered = cipher.slice(0, at) + (cipher[at] === 'A' ? 'B' : 'A') + cipher.slice(at + 1);
    expect(await decryptMeetPacket(tampered, room)).toBeNull();
    expect(await decryptMeetPacket(cipher, other)).toBeNull();
    expect(await decryptMeetPacket('short', room)).toBeNull();
  });
});

describe('meetup fragments', () => {
  it('builds and parses URL-fragment invites', () => {
    vi.stubGlobal('location', {
      origin: 'https://example.com',
      pathname: '/TrackMint/',
      search: '?x=1'
    });
    expect(meetLinkFor('ABCDEFGHJKMN')).toBe('https://example.com/TrackMint/?x=1#meet=ABCDEFGHJKMN');
    expect(parseMeetFragment('#meet=abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(parseMeetFragment('#meet=bad')).toBe('');
    expect(parseMeetFragment('#t=abc')).toBe('');
  });
});
