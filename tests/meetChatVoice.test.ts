import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_VOICE_KEEP, encodeChatVoiceBase64 } from '../src/core/chatVoice';

const harness = vi.hoisted(() => ({
  relay: { send: vi.fn(), close: vi.fn() },
  relayOptions: null as any
}));

vi.mock('../src/core/meetLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/meetLink')>();
  return {
    ...actual,
    encryptMeetPacket: vi.fn(async (packet: any) => JSON.stringify(packet)),
    decryptMeetPacket: vi.fn(async (text: string) => JSON.parse(text))
  };
});

vi.mock('../src/core/meetRelay', () => ({
  createMeetRelay: vi.fn((_roomId: string, options: any) => {
    harness.relayOptions = options;
    return harness.relay;
  })
}));

vi.mock('../src/core/webrtcTransfer', () => {
  class P2PTransferError extends Error {
    constructor(public code: string) { super(code); }
  }
  class P2PTransferManager {
    handleSignal = vi.fn(async () => undefined);
    close = vi.fn();
    closePeer = vi.fn();
    cancelFile = vi.fn();
  }
  return { P2PTransferError, P2PTransferManager, webrtcAvailable: () => true };
});

function voicePacket() {
  const bytes = new Uint8Array(32).fill(0x42);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return {
    au: encodeChatVoiceBase64(bytes),
    aut: 'audio/webm;codecs=opus',
    aud: 1200,
    auw: [0, 8, 16, 24, 31]
  };
}

let meetModule: any;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.relay.send.mockReset().mockResolvedValue(true);
  harness.relay.close.mockReset();
  harness.relayOptions = null;
  meetModule = null;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal('crypto', globalThis.crypto);
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  });
  vi.stubGlobal('navigator', {
    language: 'en',
    geolocation: { watchPosition: vi.fn(() => 1), clearWatch: vi.fn() }
  });
  vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/', search: '', hash: '' });
  vi.stubGlobal('history', { replaceState: vi.fn() });
});

afterEach(async () => {
  if (meetModule?.getMeetSnapshot().active) await meetModule.leaveMeet('switch');
  vi.unstubAllGlobals();
});

async function setup() {
  const settings = await import('../src/core/settings');
  settings.set('meetP2PEnabled', false);
  meetModule = await import('../src/core/meet');
  return meetModule.createMeetSession({ name: 'Alice' });
}

describe('meetup voice and emoji chat', () => {
  it('sends an encrypted voice message and keeps it only in memory', async () => {
    const snapshot = await setup();
    expect(await meetModule.sendMeetVoice(voicePacket())).toBe(true);
    const message = meetModule.getMeetSnapshot().messages[0];
    expect(message).toMatchObject({
      fromId: snapshot.self.id,
      self: true,
      text: '',
      voice: { data: voicePacket().au, mime: 'audio/webm;codecs=opus', duration: 1200 }
    });
    const packet = JSON.parse(harness.relay.send.mock.calls[0][0]);
    expect(packet).toMatchObject({ k: 'msg', au: voicePacket().au, aut: 'audio/webm;codecs=opus', aud: 1200 });
    expect(packet.tx).toBeUndefined();
  });

  it('receives a valid teammate voice message and drops an invalid one', async () => {
    const snapshot = await setup();
    const base = {
      k: 'msg', id: 'bob', name: 'Bob', c: '#5aa7f0', v: snapshot.protocol,
      sq: 1, ts: Date.now(), ...voicePacket()
    };
    harness.relayOptions.onMessage(JSON.stringify({ ...base, mid: 'incoming01' }));
    await vi.waitFor(() => expect(meetModule.getMeetSnapshot().messages.some((m: any) => m.voice)).toBe(true));
    const voiceMessage = meetModule.getMeetSnapshot().messages.find((m: any) => m.voice);
    expect(voiceMessage).toMatchObject({
      fromId: 'bob', name: 'Bob', self: false, voice: { duration: 1200 }
    });
    const count = meetModule.getMeetSnapshot().messages.length;

    harness.relayOptions.onMessage(JSON.stringify({
      ...base, mid: 'incoming02', sq: 2, au: 'invalid!'
    }));
    await Promise.resolve();
    expect(meetModule.getMeetSnapshot().messages).toHaveLength(count);
  });

  it('notifies only for a valid remote message and ignores duplicates', async () => {
    const snapshot = await setup();
    const events = await import('../src/core/events');
    const received = vi.fn();
    const off = events.on('meet:chat:received', received);
    try {
      expect(await meetModule.sendMeetMessage('local')).toBe(true);
      expect(received).not.toHaveBeenCalled();

      const packet = {
        k: 'msg', id: 'bob', name: 'Bob', c: '#5aa7f0', v: snapshot.protocol,
        sq: 1, ts: Date.now(), mid: 'notify01', tx: 'remote'
      };
      harness.relayOptions.onMessage(JSON.stringify(packet));
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
      expect(received).toHaveBeenLastCalledWith(expect.objectContaining({ fromId: 'bob', unread: 1 }));

      harness.relayOptions.onMessage(JSON.stringify(packet));
      await Promise.resolve();
      await Promise.resolve();
      expect(received).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('expires voice payloads beyond the bounded in-memory window', async () => {
    vi.useFakeTimers();
    try {
      await setup();
      for (let i = 0; i < CHAT_VOICE_KEEP + 1; i++) {
        expect(await meetModule.sendMeetVoice(voicePacket())).toBe(true);
        await vi.advanceTimersByTimeAsync(30_100);
      }
      const messages = meetModule.getMeetSnapshot().messages;
      expect(messages).toHaveLength(CHAT_VOICE_KEEP + 1);
      expect(messages[0].voice.data).toBeNull();
      expect(messages[0].voiceExpired).toBe(true);
      expect(messages.at(-1).voice.data).toBe(voicePacket().au);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves emoji in ordinary encrypted text messages', async () => {
    await setup();
    expect(await meetModule.sendMeetMessage('收到 😀 🎉')).toBe(true);
    expect(meetModule.getMeetSnapshot().messages[0].text).toBe('收到 😀 🎉');
  });
});
