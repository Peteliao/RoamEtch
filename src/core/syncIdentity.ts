// Sync device identity, out-of-band pairing codes and encrypted signaling.
// The QR secret never reaches the relay; the relay only forwards AES-GCM envelopes.
import { sha256Hex, stableStringify } from './integrity';
import type { SyncPairingInvite, SyncPeerIdentity } from './syncProtocol';
import { sanitizePeerName } from './syncProtocol';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PAIR_PREFIX = 'RMS1.';
const PAIR_MAX_TTL_MS = 24 * 3600_000;
const SIGNAL_MAX_AGE_MS = 5 * 60_000;

export interface SyncDeviceIdentity extends SyncPeerIdentity {
  privateJwk: JsonWebKey;
  createdAt: number;
}

export function b64urlEncode(data: Uint8Array | ArrayBuffer) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(value: string) {
  const text = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) throw new Error('sync-code');
  const padded = text + '='.repeat((4 - text.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function randomToken(bytes: number) {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function publicJwkOf(jwk: JsonWebKey): SyncPeerIdentity['publicJwk'] {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('sync-key');
  return { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) };
}

export async function deviceIdForPublicJwk(jwk: SyncPeerIdentity['publicJwk']) {
  const hash = await sha256Hex(stableStringify(publicJwkOf(jwk)));
  return `dev-${hash.slice(0, 24)}`;
}

export async function fingerprintForPublicJwk(jwk: SyncPeerIdentity['publicJwk']) {
  const hash = await sha256Hex(stableStringify(publicJwkOf(jwk)));
  return hash.slice(0, 12).toUpperCase().match(/.{4}/g)!.join(' ');
}

export async function createDeviceIdentity(name = ''): Promise<SyncDeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const publicJwk = publicJwkOf(await crypto.subtle.exportKey('jwk', pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    deviceId: await deviceIdForPublicJwk(publicJwk),
    name: sanitizePeerName(name),
    publicJwk,
    privateJwk,
    createdAt: Date.now()
  };
}

async function importPrivateKey(jwk: JsonWebKey) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function importPublicKey(jwk: SyncPeerIdentity['publicJwk']) {
  return crypto.subtle.importKey('jwk', publicJwkOf(jwk), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function signSyncText(identity: SyncDeviceIdentity, text: string) {
  const key = await importPrivateKey(identity.privateJwk);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(text));
  return b64urlEncode(signature);
}

export async function verifySyncText(jwk: SyncPeerIdentity['publicJwk'], text: string, signature: string) {
  if (typeof signature !== 'string' || signature.length > 256) return false;
  try {
    const key = await importPublicKey(jwk);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      b64urlDecode(signature),
      enc.encode(text)
    );
  } catch {
    return false;
  }
}

export async function createSyncInvite(identity: SyncDeviceIdentity, { ttlMs = 10 * 60_000, name = identity.name } = {}) {
  const now = Date.now();
  const ttl = Math.max(60_000, Math.min(PAIR_MAX_TTL_MS, Number(ttlMs) || 10 * 60_000));
  const payload: SyncPairingInvite = {
    v: 1,
    kind: 'sync',
    room: randomToken(18),
    secret: randomToken(32),
    sid: randomToken(12),
    deviceId: identity.deviceId,
    name: sanitizePeerName(name),
    jwk: identity.publicJwk,
    exp: now + ttl
  };
  return {
    ...payload,
    code: PAIR_PREFIX + b64urlEncode(enc.encode(JSON.stringify(payload)))
  };
}

export function parseSyncInvite(code: string, now = Date.now()): SyncPairingInvite | null {
  try {
    const text = String(code || '').trim();
    if (!text.startsWith(PAIR_PREFIX) || text.length > 4096) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(text.slice(PAIR_PREFIX.length))));
    if (!payload || payload.v !== 1 || payload.kind !== 'sync') return null;
    if (typeof payload.room !== 'string' || payload.room.length < 16 || payload.room.length > 128) return null;
    if (typeof payload.secret !== 'string' || payload.secret.length < 32 || payload.secret.length > 128) return null;
    if (typeof payload.sid !== 'string' || payload.sid.length < 8 || payload.sid.length > 128) return null;
    if (typeof payload.deviceId !== 'string' || !/^dev-[A-Za-z0-9_-]{6,40}$/.test(payload.deviceId)) return null;
    if (typeof payload.name !== 'string' || payload.name.length > 40) return null;
    if (!Number.isSafeInteger(payload.exp) || payload.exp < now || payload.exp > now + PAIR_MAX_TTL_MS + 60_000) return null;
    const jwk = publicJwkOf(payload.jwk);
    return {
      v: 1, kind: 'sync', room: payload.room, secret: payload.secret, sid: payload.sid,
      deviceId: payload.deviceId, name: sanitizePeerName(payload.name), jwk, exp: payload.exp
    };
  } catch {
    return null;
  }
}

/** Async because the device id is derived from the public key. */
export async function verifySyncInvite(invite: SyncPairingInvite | null) {
  if (!invite) return false;
  return invite.deviceId === await deviceIdForPublicJwk(invite.jwk);
}

export async function deriveSyncSignalKey(invite: SyncPairingInvite) {
  const material = b64urlDecode(invite.secret);
  const base = await crypto.subtle.importKey('raw', material as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: enc.encode(invite.room),
      info: enc.encode(`roametch-sync-signal-v1:${invite.sid}`)
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface SyncSealedSignal {
  v: 1;
  n: string;
  ct: string;
}

export async function sealSyncSignal(key: CryptoKey, body: any, iv?: Uint8Array) {
  const nonce = iv || crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource },
    key,
    enc.encode(JSON.stringify(body))
  );
  return b64urlEncode(enc.encode(JSON.stringify({ v: 1, n: b64urlEncode(nonce), ct: b64urlEncode(ciphertext) })));
}

export async function openSyncSignal(key: CryptoKey, text: string) {
  if (typeof text !== 'string' || text.length < 32 || text.length > 96 * 1024) return null;
  try {
    const envelope = JSON.parse(dec.decode(b64urlDecode(text))) as SyncSealedSignal;
    if (!envelope || envelope.v !== 1 || typeof envelope.n !== 'string' || typeof envelope.ct !== 'string') return null;
    const nonce = b64urlDecode(envelope.n);
    if (nonce.length !== 12 || envelope.ct.length > 96 * 1024) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce as BufferSource },
      key,
      b64urlDecode(envelope.ct)
    );
    return JSON.parse(dec.decode(plaintext));
  } catch {
    return null;
  }
}

export function syncSignalTranscript(invite: SyncPairingInvite, hello: any) {
  return stableStringify({
    kind: 'roametch-sync-hello',
    v: 1,
    room: invite.room,
    sid: invite.sid,
    deviceId: hello.deviceId,
    nonce: hello.nonce,
    at: hello.at,
    role: hello.role,
    name: hello.name,
    jwk: hello.jwk
  });
}

export async function createSyncHello(identity: SyncDeviceIdentity, invite: SyncPairingInvite, role: 'initiator' | 'responder') {
  const hello = {
    kind: 'sync-hello',
    v: 1,
    room: invite.room,
    sid: invite.sid,
    deviceId: identity.deviceId,
    name: identity.name,
    role,
    jwk: identity.publicJwk,
    nonce: randomToken(12),
    at: Date.now()
  };
  return { ...hello, sig: await signSyncText(identity, syncSignalTranscript(invite, hello)) };
}

export async function verifySyncHello(invite: SyncPairingInvite, hello: any, expectedRole: 'initiator' | 'responder', now = Date.now()) {
  if (!hello || hello.kind !== 'sync-hello' || hello.v !== 1) return null;
  if (hello.room !== invite.room || hello.sid !== invite.sid) return null;
  if (hello.role !== expectedRole) return null;
  if (!Number.isSafeInteger(hello.at) || Math.abs(now - hello.at) > SIGNAL_MAX_AGE_MS) return null;
  if (typeof hello.deviceId !== 'string' || !/^dev-[A-Za-z0-9_-]{6,40}$/.test(hello.deviceId)) return null;
  if (typeof hello.nonce !== 'string' || hello.nonce.length < 8 || hello.nonce.length > 64) return null;
  const jwk = publicJwkOf(hello.jwk);
  if (await deviceIdForPublicJwk(jwk) !== hello.deviceId) return null;
  if (!await verifySyncText(jwk, syncSignalTranscript(invite, hello), hello.sig)) return null;
  return {
    deviceId: hello.deviceId,
    name: sanitizePeerName(hello.name),
    publicJwk: jwk,
    fingerprint: await fingerprintForPublicJwk(jwk)
  } satisfies SyncPeerIdentity;
}

export function isSelfInvite(invite: SyncPairingInvite, identity: SyncDeviceIdentity) {
  return invite.deviceId === identity.deviceId;
}

export function inviteFingerprint(invite: SyncPairingInvite) {
  return fingerprintForPublicJwk(invite.jwk);
}
