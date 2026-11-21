// Ephemeral meetup room tokens: the 12-char code is both the room address seed
// and the end-to-end key material. It never leaves the URL fragment / QR code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SALT = new TextEncoder().encode('trackmint-meet-v1');
const VERSION = 1;

export type MeetRoomKey = { code: string; roomId: string; key: CryptoKey };

function b64urlEncode(u8: Uint8Array) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string) {
  const body = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(u8: Uint8Array) {
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function formatMeetCode(code: string) {
  return normalizeMeetCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

/** Accepts hyphens, spaces and case-insensitive Crockford input. */
export function normalizeMeetCode(input: string) {
  const raw = String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
  return raw.length === 12 && /^[0-9A-HJKMNP-TV-Z]{12}$/.test(raw) ? raw : '';
}

export function generateMeetCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

export async function deriveMeetRoom(codeInput: string): Promise<MeetRoomKey> {
  const code = normalizeMeetCode(codeInput);
  if (!code) throw new Error('invalid-meet-code');
  const codeBytes = new TextEncoder().encode(`trackmint-meet-code:${code}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', codeBytes));
  const roomId = hex(digest.slice(0, 16));
  const hkdf = await crypto.subtle.importKey('raw', codeBytes, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT,
      info: new TextEncoder().encode('aes-128-gcm meet payload')
    },
    hkdf,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt', 'decrypt']
  );
  return { code, roomId, key };
}

function aad(roomId: string) {
  return new TextEncoder().encode(`trackmint-meet-aad:${roomId}`);
}

export async function encryptMeetPacket(packet: unknown, room: MeetRoomKey) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(packet));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(room.roomId) },
    room.key,
    plain
  ));
  const envelope = new Uint8Array(1 + iv.length + cipher.length);
  envelope[0] = VERSION;
  envelope.set(iv, 1);
  envelope.set(cipher, 13);
  return b64urlEncode(envelope);
}

export async function decryptMeetPacket(text: string, room: MeetRoomKey): Promise<any | null> {
  if (!crypto?.subtle || typeof text !== 'string' || text.length > 8192 || text.length < 20) return null;
  try {
    const bytes = b64urlDecode(text);
    if (bytes[0] !== VERSION || bytes.length < 30) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: aad(room.roomId) },
      room.key,
      bytes.slice(13)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

export function meetLinkFor(codeInput: string) {
  const code = normalizeMeetCode(codeInput);
  return `${location.origin}${location.pathname}${location.search}#meet=${code}`;
}

export function parseMeetFragment(hash: string) {
  if (!hash || !/[#&]meet=/.test(hash)) return '';
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return normalizeMeetCode(params.get('meet') || '');
}

export function randomMeetId() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(9)));
}
