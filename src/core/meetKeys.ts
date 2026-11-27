// Meetup security primitives: protocol negotiation, pairwise ECDH channels and
// host-driven epoch rotation. A removed member never receives the new epoch
// secret, so they cannot decrypt traffic sent after the roster changes.
import type { MeetRoomKey } from './meetLink';

export const MEET_PROTOCOL_MIN = 3;
export const MEET_PROTOCOL_MAX = 3;
export const MEET_VERSION_MIN_FEATURE = 4;
export const MEET_EPOCH_SECRET_BYTES = 32;
export const MEET_PUBLIC_KEY_BYTES = 65;
const DIRECT_AAD = new TextEncoder().encode('roametch-meet-direct-v1');

export type MeetProtocolVerdict =
  | { ok: true; version: number }
  | { ok: false; reason: 'old' | 'new' | 'missing'; peerMin: number; peerMax: number };

export type MeetKeyPair = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicRaw: Uint8Array;
  publicB64: string;
};

function b64urlEncode(u8: Uint8Array) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text: string) {
  const body = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!body || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
  try {
    const bin = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function encodeSecret(secret: Uint8Array) {
  return b64urlEncode(secret);
}

export function decodeEpochSecret(value: unknown) {
  const bytes = b64urlDecode(String(value || ''));
  return bytes && bytes.length === MEET_EPOCH_SECRET_BYTES ? bytes : null;
}

export function negotiateMeetProtocol(peerMin: unknown, peerMax: unknown, peerVersion: unknown): MeetProtocolVerdict {
  const min = Math.round(Number(peerMin));
  const max = Math.round(Number(peerMax));
  const version = Math.round(Number(peerVersion));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    return { ok: false, reason: 'missing', peerMin: 0, peerMax: 0 };
  }
  if (max < MEET_PROTOCOL_MIN) return { ok: false, reason: 'old', peerMin: min, peerMax: max };
  if (min > MEET_PROTOCOL_MAX) return { ok: false, reason: 'new', peerMin: min, peerMax: max };
  const negotiated = Math.min(MEET_PROTOCOL_MAX, max);
  return {
    ok: true,
    version: Number.isFinite(version) && version >= min && version <= max ? version : negotiated
  };
}

export async function generateMeetKeyPair(): Promise<MeetKeyPair> {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicRaw,
    publicB64: b64urlEncode(publicRaw)
  };
}

export async function importMeetPublicKey(value: unknown) {
  const raw = b64urlDecode(String(value || ''));
  if (!raw || raw.length !== MEET_PUBLIC_KEY_BYTES || raw[0] !== 4) return null;
  try {
    return await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
  } catch {
    return null;
  }
}

export async function deriveMeetPairwiseKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  roomId: string,
  selfId: string,
  peerId: string
) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  const ordered = [selfId, peerId].sort();
  const hkdf = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`roametch-meet-pair-v1|${roomId}|${ordered[0]}|${ordered[1]}`),
      info: new TextEncoder().encode('pairwise-aes-256-gcm')
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealMeetDirect(key: CryptoKey, packet: unknown) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(packet));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: DIRECT_AAD },
    key,
    plain
  ));
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return b64urlEncode(out);
}

export async function openMeetDirect(key: CryptoKey, box: unknown) {
  if (!crypto?.subtle) return null;
  const bytes = b64urlDecode(String(box || ''));
  if (!bytes || bytes.length < 29) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: DIRECT_AAD },
      key,
      bytes.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

function epochPayload(secret: Uint8Array) {
  return secret.slice();
}

export async function deriveMeetEpochKey(roomId: string, epoch: number, secret: Uint8Array) {
  if (!crypto?.subtle) throw new Error('crypto-unavailable');
  if (!Number.isSafeInteger(epoch) || epoch <= 0 || secret.length !== MEET_EPOCH_SECRET_BYTES) {
    throw new Error('invalid-meet-epoch');
  }
  const hkdf = await crypto.subtle.importKey('raw', epochPayload(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`roametch-meet-epoch-v1|${roomId}`),
      info: new TextEncoder().encode(`epoch:${epoch}|aes-256-gcm`)
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export function generateEpochSecret() {
  return crypto.getRandomValues(new Uint8Array(MEET_EPOCH_SECRET_BYTES));
}

export function epochSecretB64(secret: Uint8Array) {
  return encodeSecret(secret);
}

/** A fresh nonce prefix per key epoch avoids reusing GCM IVs across rotations. */
export function meetRoomWithKey(room: MeetRoomKey, key: CryptoKey): MeetRoomKey {
  return {
    ...room,
    key,
    noncePrefix: crypto.getRandomValues(new Uint8Array(8)),
    nonceCounter: 0n
  };
}

export type MeetVisibility = 'full' | 'hidden';

/**
 * Location delivery plan: broadcast while every active peer is visible; switch
 * to pairwise direct sends as soon as one peer is hidden so they never see the
 * plaintext location envelope.
 */
export function meetLocationPlan(
  peerIds: string[],
  visibility: Map<string, MeetVisibility>,
  directReady: Set<string>
) {
  const visible = peerIds.filter((id) => visibility.get(id) !== 'hidden');
  const hidden = peerIds.length - visible.length;
  if (!peerIds.length) return { mode: 'none' as const, targets: [] as string[], hidden: 0 };
  if (!hidden) return { mode: 'broadcast' as const, targets: [], hidden: 0 };
  return {
    mode: 'direct' as const,
    targets: visible.filter((id) => directReady.has(id)),
    hidden
  };
}
