import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  relay: { send: vi.fn(), close: vi.fn() },
  relayOptions: null as any,
  managers: [] as any[]
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
    constructor(public code: string) {
      super(code);
      this.name = 'P2PTransferError';
    }
  }
  class P2PTransferManager {
    closed = false;
    handleSignal = vi.fn(async () => undefined);
    close = vi.fn(() => { this.closed = true; });
    constructor(public options: any) {
      harness.managers.push(this);
    }
  }
  return { P2PTransferError, P2PTransferManager, webrtcAvailable: () => true };
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function outgoing(msgId: string) {
  return {
    msgId,
    sessionId: `session-${msgId}`,
    toPeerId: 'bob',
    type: 'ice' as const,
    payload: { candidate: { candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 5000 typ host' } }
  };
}

function incoming(selfId: string, protocol: number, msgId: string) {
  return {
    k: 'rtc', id: 'bob', to: selfId, mid: msgId, sid: `session-${msgId}`,
    typ: 'abort', p: { fileId: 'original123' }, ts: Date.now(), v: protocol, sq: 1
  };
}

let meetModule: any;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.relay.send.mockReset().mockResolvedValue(true);
  harness.relay.close.mockReset();
  harness.relayOptions = null;
  harness.managers.length = 0;
  meetModule = null;
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  vi.stubGlobal('crypto', webcrypto);
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
  settings.set('meetP2PEnabled', true);
  meetModule = await import('../src/core/meet');
  const snapshot = await meetModule.createMeetSession({ name: 'Alice' });
  const manager = harness.managers[0];
  return { snapshot, manager, publish: manager.options.publish };
}

async function deliver(packet: unknown) {
  harness.relayOptions.onMessage(JSON.stringify(packet));
  await Promise.resolve();
}

describe('meetup RTC signaling lane', () => {
  it('drops queued RTC signals immediately while still sending the critical bye', async () => {
    const { publish } = await setup();
    const firstSend = deferred<boolean>();
    const byeSend = deferred<boolean>();
    harness.relay.send
      .mockImplementationOnce(() => firstSend.promise)
      .mockImplementationOnce(() => byeSend.promise)
      .mockResolvedValue(true);
    const first = publish(outgoing('message001'));
    const queued = publish(outgoing('message002'));
    await vi.waitFor(() => expect(harness.relay.send).toHaveBeenCalledTimes(1));

    const leaving = meetModule.leaveMeet();
    await vi.waitFor(() => expect(harness.relay.send).toHaveBeenCalledTimes(2));
    firstSend.resolve(true);
    expect(await first).toBe(true);
    expect(await queued).toBe(false);
    expect(harness.relay.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(harness.relay.send.mock.calls[1][0])).toMatchObject({ k: 'bye' });

    byeSend.resolve(true);
    await leaving;
  });

  it('invalidates queued and future RTC signals when P2P stops', async () => {
    const { publish, manager } = await setup();
    const firstSend = deferred<boolean>();
    harness.relay.send.mockImplementationOnce(() => firstSend.promise).mockResolvedValue(true);
    const first = publish(outgoing('message001'));
    const queued = publish(outgoing('message002'));
    await vi.waitFor(() => expect(harness.relay.send).toHaveBeenCalledTimes(1));

    meetModule.stopMeetP2P();
    firstSend.resolve(true);
    expect(await first).toBe(true);
    expect(await queued).toBe(false);
    expect(await publish(outgoing('message003'))).toBe(false);
    expect(manager.closed).toBe(true);
    expect(harness.relay.send).toHaveBeenCalledTimes(1);
  });

  it('allows a privacy refusal but blocks other signals after P2P is disabled', async () => {
    const { publish } = await setup();
    const settings = await import('../src/core/settings');
    settings.set('meetP2PEnabled', false);
    meetModule.stopMeetP2P();
    expect(await publish(outgoing('message001'))).toBe(false);
    expect(await publish({
      msgId: 'message002', sessionId: 'session-message002', toPeerId: 'bob', type: 'pull-reject',
      payload: { fileId: 'original123', reason: 'privacy-disabled' }
    })).toBe(true);
  });

  it('resumes the RTC lane when P2P is re-enabled', async () => {
    const { publish } = await setup();
    meetModule.stopMeetP2P();
    expect(await publish(outgoing('message001'))).toBe(false);
    meetModule.resumeMeetP2P();
    expect(await publish(outgoing('message002'))).toBe(true);
  });

  it('starts a fresh RTC lane after resetting the room code', async () => {
    const { publish } = await setup();
    const firstSend = deferred<boolean>();
    harness.relay.send.mockImplementationOnce(() => firstSend.promise).mockResolvedValue(true);
    const first = publish(outgoing('message001'));
    const queued = publish(outgoing('message002'));
    await vi.waitFor(() => expect(harness.relay.send).toHaveBeenCalledTimes(1));

    await meetModule.resetMeetCode();
    firstSend.resolve(true);
    expect(await first).toBe(true);
    expect(await queued).toBe(false);
    expect(harness.managers[0].closed).toBe(true);
    expect(harness.managers).toHaveLength(2);
    expect(await harness.managers[1].options.publish(outgoing('message003'))).toBe(true);
  });

  it('ignores incoming RTC signals once leaving starts', async () => {
    const { snapshot, manager } = await setup();
    await deliver(incoming(snapshot.self.id, snapshot.protocol, 'incoming01'));
    expect(manager.handleSignal).toHaveBeenCalledTimes(1);

    const byeSend = deferred<boolean>();
    harness.relay.send.mockImplementation(() => byeSend.promise);
    const leaving = meetModule.leaveMeet();
    await deliver(incoming(snapshot.self.id, snapshot.protocol, 'incoming02'));
    expect(manager.handleSignal).toHaveBeenCalledTimes(1);

    byeSend.resolve(true);
    await leaving;
  });
});
