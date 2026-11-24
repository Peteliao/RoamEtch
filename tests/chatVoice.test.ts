import { describe, expect, it } from 'vitest';
import {
  CHAT_VOICE_MAX_BASE64,
  CHAT_VOICE_MAX_BYTES,
  CHAT_VOICE_MAX_DURATION_MS,
  CHAT_VOICE_MIMES,
  chatVoiceBlob,
  encodeChatVoiceBase64,
  sanitizeChatVoicePacket
} from '../src/core/chatVoice';
import { deriveMeetRoom, encryptMeetPacket, MEET_MAX_PACKET_CHARS } from '../src/core/meetLink';

function voiceBytes(mime: typeof CHAT_VOICE_MIMES[number], size = 32) {
  const bytes = new Uint8Array(size).fill(0x42);
  if (mime === 'audio/webm;codecs=opus') bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  else if (mime === 'audio/ogg;codecs=opus') bytes.set([0x4f, 0x67, 0x67, 0x53]);
  else bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  return bytes;
}

function packet(mime: typeof CHAT_VOICE_MIMES[number] = 'audio/webm;codecs=opus') {
  return {
    au: encodeChatVoiceBase64(voiceBytes(mime)),
    aut: mime,
    aud: 1200,
    auw: [0, 4, 8, 12, 16, 20, 24, 28, 31]
  };
}

describe('chat voice packets', () => {
  it.each(CHAT_VOICE_MIMES)('accepts a bounded %s payload', (mime) => {
    const input = packet(mime);
    expect(sanitizeChatVoicePacket(input)).toEqual({
      base64: input.au, mime, duration: input.aud, waveform: input.auw
    });
  });

  it('creates a playable blob only for a valid container header', () => {
    const voice = sanitizeChatVoicePacket(packet())!;
    const blob = chatVoiceBlob(voice)!;
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(blob.size).toBe(32);
    expect(chatVoiceBlob({ ...voice, mime: 'audio/ogg;codecs=opus' })).toBeNull();
  });

  it('rejects malformed, oversized and unsupported voice data', () => {
    expect(sanitizeChatVoicePacket({ ...packet(), au: 'not base64!' })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), au: 'A'.repeat(CHAT_VOICE_MAX_BASE64 + 4) })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), aut: 'audio/wav' })).toBeNull();
    expect(sanitizeChatVoicePacket({
      ...packet(), au: encodeChatVoiceBase64(new Uint8Array(32).fill(0x42))
    })).toBeNull();
  });

  it('rejects invalid duration and waveform metadata', () => {
    expect(sanitizeChatVoicePacket({ ...packet(), aud: 0 })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), aud: CHAT_VOICE_MAX_DURATION_MS + 1 })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), auw: [32] })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), auw: Array(33).fill(1) })).toBeNull();
    expect(sanitizeChatVoicePacket({ ...packet(), auw: 'not-an-array' })).toBeNull();
  });

  it('keeps a maximum-size voice message inside the encrypted relay limit', async () => {
    const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const room = await deriveMeetRoom(`TM2.${base64url(new Uint8Array(16).fill(0xab))}.${base64url(new Uint8Array(32).fill(0xcd))}`);
    const bytes = voiceBytes('audio/webm;codecs=opus', CHAT_VOICE_MAX_BYTES);
    const cipher = await encryptMeetPacket({
      v: 2, k: 'msg', id: 'peer-a', sq: 1,
      au: encodeChatVoiceBase64(bytes), aut: 'audio/webm;codecs=opus', aud: 15_000, auw: []
    }, room);
    expect(cipher.length).toBeLessThanOrEqual(MEET_MAX_PACKET_CHARS);
  });
});
