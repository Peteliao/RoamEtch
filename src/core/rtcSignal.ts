import { LOCAL_IMAGE_MAX_BYTES } from './chatImage';

export const RTC_SIGNAL_MAX_AGE_MS = 30_000;
export const RTC_SIGNAL_MAX_FUTURE_MS = 5_000;
export const RTC_SIGNAL_SEEN_LIMIT = 500;
export const RTC_SIGNAL_RATE_WINDOW_MS = 3_000;
export const RTC_SIGNAL_RATE_LIMIT = 40;

export type RtcSignalType = 'pull-req' | 'pull-reject' | 'offer' | 'answer' | 'ice' | 'abort';
export type RtcRejectReason = 'expired' | 'busy' | 'privacy-disabled' | 'ice-timeout';

export type RtcSignalPayload = {
  fileId?: string;
  sha256?: string;
  size?: number;
  reason?: RtcRejectReason;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export type RtcSignalMessage = {
  kind: 'rtc-signal';
  msgId: string;
  sessionId: string;
  fromPeerId: string;
  toPeerId: string;
  type: RtcSignalType;
  ts: number;
  payload: RtcSignalPayload;
};

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SHA256_RE = /^[A-Fa-f0-9]{64}$/;
const TYPES = new Set<RtcSignalType>(['pull-req', 'pull-reject', 'offer', 'answer', 'ice', 'abort']);
const REASONS = new Set<RtcRejectReason>(['expired', 'busy', 'privacy-disabled', 'ice-timeout']);

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanId(value: unknown) {
  return typeof value === 'string' && ID_RE.test(value) ? value : '';
}

function cleanFileId(value: unknown) {
  return typeof value === 'string' && ID_RE.test(value) ? value : '';
}

function cleanHash(value: unknown) {
  return typeof value === 'string' && SHA256_RE.test(value) ? value.toLowerCase() : '';
}

function cleanSize(value: unknown) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 && size <= LOCAL_IMAGE_MAX_BYTES ? size : 0;
}

function cleanSdp(value: unknown, expected: 'offer' | 'answer'): RTCSessionDescriptionInit | null {
  if (!record(value) || value.type !== expected || typeof value.sdp !== 'string') return null;
  if (!value.sdp || value.sdp.length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.sdp)) return null;
  return { type: expected, sdp: value.sdp };
}

function cleanCandidate(value: unknown): RTCIceCandidateInit | null {
  if (!record(value) || typeof value.candidate !== 'string' || !value.candidate || value.candidate.length > 4096) return null;
  if (value.sdpMid != null && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 256)) return null;
  if (value.sdpMLineIndex != null && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 1024)) return null;
  if (value.usernameFragment != null && (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256)) return null;
  return {
    candidate: value.candidate,
    sdpMid: value.sdpMid ?? undefined,
    sdpMLineIndex: value.sdpMLineIndex ?? undefined,
    usernameFragment: value.usernameFragment ?? undefined
  };
}

export function sanitizeRtcSignal(msg: any, selfPeerId: string, now = Date.now()): RtcSignalMessage | null {
  if (!record(msg) || msg.k !== 'rtc') return null;
  const type = msg.typ as RtcSignalType;
  if (!TYPES.has(type)) return null;
  const msgId = cleanId(msg.mid);
  const sessionId = cleanId(msg.sid);
  const fromPeerId = typeof msg.id === 'string' ? msg.id.slice(0, 40) : '';
  const toPeerId = typeof msg.to === 'string' ? msg.to.slice(0, 40) : '';
  const ts = Number(msg.ts);
  if (!msgId || !sessionId || !PEER_ID_RE.test(fromPeerId) || fromPeerId === selfPeerId) return null;
  if (!PEER_ID_RE.test(toPeerId) || toPeerId !== selfPeerId) return null;
  if (!Number.isFinite(ts) || now - ts > RTC_SIGNAL_MAX_AGE_MS || ts - now > RTC_SIGNAL_MAX_FUTURE_MS) return null;
  if (!record(msg.p)) return null;

  const payload: RtcSignalPayload = {};
  const fileId = cleanFileId(msg.p.fileId);
  if (msg.p.fileId != null && !fileId) return null;
  if (fileId) payload.fileId = fileId;

  if (type === 'pull-req') {
    const sha256 = cleanHash(msg.p.sha256);
    const size = cleanSize(msg.p.size);
    if (!fileId || !sha256 || !size) return null;
    payload.sha256 = sha256;
    payload.size = size;
  } else if (type === 'pull-reject') {
    if (!fileId || !REASONS.has(msg.p.reason)) return null;
    payload.reason = msg.p.reason;
  } else if (type === 'offer' || type === 'answer') {
    const sdp = cleanSdp(msg.p.sdp, type);
    if (!sdp) return null;
    payload.sdp = sdp;
  } else if (type === 'ice') {
    const candidate = cleanCandidate(msg.p.candidate);
    if (!candidate) return null;
    payload.candidate = candidate;
  } else if (msg.p.reason != null) {
    if (!REASONS.has(msg.p.reason)) return null;
    payload.reason = msg.p.reason;
  }

  return { kind: 'rtc-signal', msgId, sessionId, fromPeerId, toPeerId, type, ts, payload };
}

export class SignalDeduplicator {
  private seen = new Map<string, number>();

  accept(fromPeerId: string, msgId: string, now = Date.now()) {
    if (!fromPeerId || !msgId) return false;
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt <= RTC_SIGNAL_MAX_AGE_MS) break;
      this.seen.delete(key);
    }
    const key = `${fromPeerId}\u0000${msgId}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    if (this.seen.size > RTC_SIGNAL_SEEN_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }
    return true;
  }

  clear() {
    this.seen.clear();
  }

  get size() {
    return this.seen.size;
  }
}

export class RtcSignalRateLimiter {
  private recent = new Map<string, number[]>();

  accept(peerId: string, now = Date.now()) {
    const times = (this.recent.get(peerId) || []).filter((at) => now - at < RTC_SIGNAL_RATE_WINDOW_MS);
    if (times.length >= RTC_SIGNAL_RATE_LIMIT) {
      this.recent.set(peerId, times);
      return false;
    }
    times.push(now);
    this.recent.set(peerId, times);
    return true;
  }

  prune(now = Date.now()) {
    for (const [peerId, times] of this.recent) {
      const live = times.filter((at) => now - at < RTC_SIGNAL_RATE_WINDOW_MS);
      if (live.length) this.recent.set(peerId, live);
      else this.recent.delete(peerId);
    }
  }

  clear() {
    this.recent.clear();
  }
}
