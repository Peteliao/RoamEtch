import { describe, expect, it } from 'vitest';
import {
  RTC_SIGNAL_MAX_AGE_MS,
  RTC_SIGNAL_RATE_LIMIT,
  RTC_SIGNAL_RATE_WINDOW_MS,
  RTC_SIGNAL_SEEN_LIMIT,
  RtcSignalRateLimiter,
  SignalDeduplicator,
  sanitizeRtcSignal,
  type RtcSignalMessage
} from '../src/core/rtcSignal';

const now = 1_800_000_000_000;
const hash = 'a'.repeat(64);

function packet(patch: Record<string, any> = {}) {
  return {
    k: 'rtc', id: 'peer-alice', to: 'peer-bob', mid: 'message-1234', sid: 'session-1234',
    typ: 'pull-req', ts: now, p: { fileId: 'file-1234', sha256: hash, size: 4096 }, ...patch
  };
}

describe('RTC signal validation', () => {
  it('normalizes a targeted pull request', () => {
    expect(sanitizeRtcSignal(packet(), 'peer-bob', now)).toEqual({
      kind: 'rtc-signal', msgId: 'message-1234', sessionId: 'session-1234',
      fromPeerId: 'peer-alice', toPeerId: 'peer-bob', type: 'pull-req', ts: now,
      payload: { fileId: 'file-1234', sha256: hash, size: 4096 }
    });
  });

  it.each([
    ['wrong target', packet({ to: 'peer-carol' })],
    ['self sender', packet({ id: 'peer-bob' })],
    ['expired', packet({ ts: now - 30_001 })],
    ['future clock skew', packet({ ts: now + 5_001 })],
    ['unknown type', packet({ typ: 'answer' })],
    ['bad hash', packet({ p: { fileId: 'file-1234', sha256: 'no', size: 4096 } })],
    ['oversized file', packet({ p: { fileId: 'file-1234', sha256: hash, size: 32 * 1024 * 1024 + 1 } })]
  ])('rejects %s', (_name, value) => {
    expect(sanitizeRtcSignal(value, 'peer-bob', now)).toBeNull();
  });

  it('accepts a restart request bound to the requested file', () => {
    expect(sanitizeRtcSignal(packet({ typ: 'restart-req' }), 'peer-bob', now)).toMatchObject({
      type: 'restart-req', payload: { fileId: 'file-1234' }
    });
    expect(sanitizeRtcSignal(packet({ typ: 'restart-req', p: {} }), 'peer-bob', now)).toBeNull();
  });

  it('accepts bounded SDP and ICE payloads for their matching branches', () => {
    expect(sanitizeRtcSignal(packet({ typ: 'offer', p: { sdp: { type: 'offer', sdp: 'v=0\r\n' } } }), 'peer-bob', now)?.payload.sdp)
      .toEqual({ type: 'offer', sdp: 'v=0\r\n' });
    expect(sanitizeRtcSignal(packet({ typ: 'ice', p: { candidate: { candidate: 'candidate:host 1 UDP 4 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } } }), 'peer-bob', now)?.payload.candidate)
      .toMatchObject({ sdpMid: '0', sdpMLineIndex: 0 });
    expect(sanitizeRtcSignal(packet({ typ: 'offer', p: { sdp: { type: 'answer', sdp: 'v=0' } } }), 'peer-bob', now)).toBeNull();
    expect(sanitizeRtcSignal(packet({ typ: 'offer', p: { sdp: { type: 'offer', sdp: 'x'.repeat(32_769) } } }), 'peer-bob', now)).toBeNull();
  });
});

describe('RTC signal deduplicator', () => {
  it('filters repeated MQTT deliveries per sender and evicts the oldest id after 500 entries', () => {
    const dedup = new SignalDeduplicator();
    expect(dedup.accept('peer-alice', 'first', now)).toBe(true);
    expect(dedup.accept('peer-alice', 'first', now)).toBe(false);
    expect(dedup.accept('peer-bob', 'first', now)).toBe(true);
    for (let i = 0; i < RTC_SIGNAL_SEEN_LIMIT - 1; i++) dedup.accept('peer-alice', `id-${i}`, now);
    expect(dedup.size).toBe(RTC_SIGNAL_SEEN_LIMIT);
    expect(dedup.accept('peer-alice', 'first', now)).toBe(true);
    dedup.clear();
    expect(dedup.size).toBe(0);
  });

  it('prunes signal identities older than the replay window', () => {
    const dedup = new SignalDeduplicator();
    expect(dedup.accept('peer-alice', 'old', now)).toBe(true);
    expect(dedup.accept('peer-alice', 'old', now + RTC_SIGNAL_MAX_AGE_MS + 1)).toBe(true);
    expect(dedup.size).toBe(1);
  });
});

describe('RTC signal rate limiter', () => {
  it('bounds each sender independently and accepts traffic again after the window', () => {
    const limiter = new RtcSignalRateLimiter();
    for (let i = 0; i < RTC_SIGNAL_RATE_LIMIT; i++) expect(limiter.accept('peer-alice', now)).toBe(true);
    expect(limiter.accept('peer-alice', now)).toBe(false);
    expect(limiter.accept('peer-bob', now)).toBe(true);
    expect(limiter.accept('peer-alice', now + RTC_SIGNAL_RATE_WINDOW_MS)).toBe(true);
  });
});
