// Ephemeral meetup invites: a random public room id plus a 256-bit bearer
// secret. Both live only in the URL fragment / QR code; the relay receives the
// room id and opaque ciphertext, never the secret.
const VERSION = 2;
const INVITE_PREFIX = 'TM2';
const ROOM_ID_BYTES = 16;
const SECRET_BYTES = 32;
const NONCE_PREFIX_BYTES = 8;
const NONCE_MAX = 0xffffffff;
const SALT = new TextEncoder().encode('trackmint-meet-v2');
const INVITE_RE = /^TM2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export const MEET_PROTOCOL_VERSION = VERSION;
export const MEET_MAX_PACKET_CHARS = 128 * 1024;

export type MeetInviteParts = { invite: string; roomId: string; secret: Uint8Array<ArrayBuffer> };

export type MeetRoomKey = {
  invite: string;
  roomId: string;
  key: CryptoKey;
  noncePrefix: Uint8Array<ArrayBuffer>;
  nonceCounter: bigint;
};

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

function extractInviteValue(input: string) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  const at = value.search(/[#&?]meet=/i);
  if (at >= 0) value = value.slice(at + 6);
  value = value.split('&')[0].trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    return '';
  }
  return value.replace(/\s+/g, '');
}

/** Accepts a canonical TM2 invite, a full invite link, or a URL fragment. */
export function normalizeMeetInvite(input: string) {
  const value = extractInviteValue(input);
  const match = INVITE_RE.exec(value);
  if (!match) return '';
  try {
    const room = b64urlDecode(match[1]);
    const secret = b64urlDecode(match[2]);
    if (room.length !== ROOM_ID_BYTES || secret.length !== SECRET_BYTES) return '';
    if (b64urlEncode(room) !== match[1] || b64urlEncode(secret) !== match[2]) return '';
  } catch {
    return '';
  }
  return value;
}

export function parseMeetInvite(input: string): MeetInviteParts | null {
  const invite = normalizeMeetInvite(input);
  if (!invite) return null;
  const match = INVITE_RE.exec(invite);
  if (!match) return null;
  return { invite, roomId: match[1], secret: b64urlDecode(match[2]) };
}

/** Detects the retired 12-character v1 code so the UI can explain the break. */
export function isLegacyMeetCode(input: string) {
  const raw = extractInviteValue(input)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
  return raw.length === 12 && /^[0-9A-HJKMNP-TV-Z]{12}$/.test(raw);
}

export function generateMeetInvite() {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_ID_BYTES + SECRET_BYTES));
  const roomId = b64urlEncode(bytes.slice(0, ROOM_ID_BYTES));
  const secret = b64urlEncode(bytes.slice(ROOM_ID_BYTES));
  return `${INVITE_PREFIX}.${roomId}.${secret}`;
}

/** Public, non-secret label shown in the map header. */
export function roomLabelFor(roomId: string) {
  return String(roomId || '').slice(0, 8).toUpperCase().replace(/(.{4})(?=.)/g, '$1-');
}

export async function deriveMeetRoom(codeInput: string): Promise<MeetRoomKey> {
  const parts = parseMeetInvite(codeInput);
  if (!parts) {
    if (isLegacyMeetCode(codeInput)) throw new Error('legacy-meet-invite');
    throw new Error('invalid-meet-invite');
  }
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const hkdf = await crypto.subtle.importKey('raw', parts.secret, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT,
      info: new TextEncoder().encode(`aes-256-gcm meet payload v2|room:${parts.roomId}`)
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return {
    invite: parts.invite,
    roomId: parts.roomId,
    key,
    noncePrefix: crypto.getRandomValues(new Uint8Array(NONCE_PREFIX_BYTES)),
    nonceCounter: 0n
  };
}

function aad(roomId: string) {
  return new TextEncoder().encode(`trackmint-meet-v2-aad:${roomId}`);
}

function nextNonce(room: MeetRoomKey) {
  if (room.nonceCounter > BigInt(NONCE_MAX)) throw new Error('meet-nonce-exhausted');
  const counter = Number(room.nonceCounter);
  const iv = new Uint8Array(12);
  iv.set(room.noncePrefix, 0);
  iv[8] = (counter >>> 24) & 0xff;
  iv[9] = (counter >>> 16) & 0xff;
  iv[10] = (counter >>> 8) & 0xff;
  iv[11] = counter & 0xff;
  room.nonceCounter = room.nonceCounter + 1n;
  return iv;
}

export async function encryptMeetPacket(packet: unknown, room: MeetRoomKey) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const iv = nextNonce(room);
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
  if (!crypto?.subtle || typeof text !== 'string' || text.length > MEET_MAX_PACKET_CHARS || text.length < 32) return null;
  try {
    const bytes = b64urlDecode(text);
    if (bytes[0] !== VERSION || bytes.length < 29) return null;
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
  const invite = normalizeMeetInvite(codeInput);
  if (!invite) throw new Error('invalid-meet-invite');
  return `${location.origin}${location.pathname}${location.search}#meet=${invite}`;
}

export function parseMeetFragment(hash: string) {
  if (!hash || !/[#&]meet=/.test(hash)) return '';
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return normalizeMeetInvite(params.get('meet') || '');
}

export function randomMeetId() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(9)));
}
