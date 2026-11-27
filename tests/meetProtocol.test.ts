import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

let meetModule: any;
let now = 1_700_000_000_000;

function advance(ms: number) {
  now += ms;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function deliver(packet: unknown) {
  harness.relayOptions.onMessage(JSON.stringify(packet));
  await flush();
}

function base(protocol: number, seq: number, overrides: any = {}) {
  return {
    k: 'loc', id: 'bob', name: 'Bob', c: '#5aa7f0', v: protocol,
    sq: seq, ts: now, la: 31.2, lo: 121.3, ac: 10, hd: null, sp: 0, sh: true,
    ...overrides
  };
}

function statePacket(protocol: number, seq: number, sharing: boolean, overrides: any = {}) {
  return base(protocol, seq, { k: 'st', sh: sharing, ...overrides });
}

function peer(id = 'bob') {
  return meetModule.getMeetSnapshot().peers.find((entry: any) => entry.id === id);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.relay.send.mockReset().mockResolvedValue(true);
  harness.relay.close.mockReset();
  harness.relayOptions = null;
  meetModule = null;
  now = 1_700_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup() {
  const settings = await import('../src/core/settings');
  settings.set('meetP2PEnabled', false);
  meetModule = await import('../src/core/meet');
  return meetModule.createMeetSession({ name: 'Alice' });
}

describe('meetup network and GPS freshness protocol', () => {
  it('publishes the real GPS sample time in ft while ts remains the send time', async () => {
    const snapshot = await setup();
    const sampledAt = now - 120_000;
    meetModule.injectMeetFix({ lat: 30.1, lon: 120.2, acc: 8, ts: sampledAt });
    await flush();

    const sent = harness.relay.send.mock.calls
      .map(([text]) => JSON.parse(text))
      .find((packet) => packet.k === 'loc');
    expect(sent).toMatchObject({ ft: sampledAt, ts: now });
    expect(meetModule.getMeetSnapshot().self.fixAt).toBe(sampledAt);
    expect(meetModule.getMeetSnapshot().self).toMatchObject({
      lastFixAt: sampledAt,
      fixAge: 120_000,
      positionStatus: 'stale'
    });

    meetModule.injectMeetFix({ lat: 29.1, lon: 119.2, acc: 8, ts: sampledAt - 1 });
    expect(meetModule.getMeetSnapshot().self.lat).toBe(30.1);
  });

  it('keeps network contact online while heartbeats continue and GPS expires at 60 seconds', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { ft: now }));
    const first = peer();
    expect(first).toMatchObject({ networkStatus: 'online', positionStatus: 'fresh', fixAge: 0 });

    advance(46_000);
    await deliver(statePacket(snapshot.protocol, 2, true));
    expect(peer()).toMatchObject({
      networkStatus: 'online', positionStatus: 'fresh',
      lastContactAt: now, lastSeen: now, lastLocAt: first.lastLocAt
    });

    advance(14_000);
    await deliver(statePacket(snapshot.protocol, 3, true));
    expect(peer()).toMatchObject({
      networkStatus: 'online', positionStatus: 'stale', fixAge: 60_000,
      lastContactAt: now, lastSeen: now, lastLocAt: first.lastLocAt,
      lastFixAt: first.lastFixAt, stale: false
    });
  });

  it('derives network offline independently from a still-fresh position', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { ft: now }));
    advance(46_000);
    expect(peer()).toMatchObject({
      networkStatus: 'offline', positionStatus: 'fresh',
      stale: true, age: 46_000, fixAge: 46_000
    });
  });

  it('normalizes GPS age when the sender clock is ahead', async () => {
    const snapshot = await setup();
    const skew = 120_000;
    await deliver(base(snapshot.protocol, 1, { k: 'hi', ts: now + skew }));
    advance(10_000);
    await deliver(base(snapshot.protocol, 2, { ts: now + skew, ft: now }));
    expect(peer()).toMatchObject({
      lastFixAt: now,
      positionUpdatedAt: now - skew,
      fixAge: skew,
      positionStatus: 'stale'
    });

    await deliver(base(snapshot.protocol, 3, { ts: now + skew, ft: now + 90_000, la: 31.4 }));
    expect(peer()).toMatchObject({
      lat: 31.4,
      positionUpdatedAt: now - 30_000,
      fixAge: 30_000,
      positionStatus: 'fresh'
    });
  });

  it('does not let duplicate or out-of-order packets rewrite a position', async () => {
    const snapshot = await setup();
    const sampledAt = now - 10_000;
    await deliver(base(snapshot.protocol, 1, { ft: sampledAt }));
    const first = peer();

    await deliver(base(snapshot.protocol, 1, { ft: now, la: 32.2 }));
    await deliver(base(snapshot.protocol, 2, { ft: sampledAt, la: 33.3 }));
    await deliver(base(snapshot.protocol, 1, { ft: now + 1_000, la: 34.4 }));
    expect(peer()).toMatchObject({
      lat: first.lat,
      lon: first.lon,
      lastFixAt: sampledAt,
      fixAge: 10_000,
      positionStatus: 'fresh'
    });
  });

  it('accepts delayed location contact without accepting its older sample', async () => {
    const snapshot = await setup();
    const firstFix = now;
    await deliver(base(snapshot.protocol, 1, { ft: firstFix }));
    advance(5_000);
    const latestFix = now - 2_000;
    await deliver(base(snapshot.protocol, 2, { ft: latestFix, la: 31.5 }));
    const receivedAt = now;
    await deliver(base(snapshot.protocol, 3, { ft: firstFix - 30_000, la: 31.6 }));
    expect(peer()).toMatchObject({
      lat: 31.5,
      lastFixAt: latestFix,
      lastLocAt: receivedAt,
      fixAge: 2_000,
      positionStatus: 'fresh'
    });
  });

  it('marks legacy ts fallback as approximate and keeps old cached locations stale', async () => {
    const snapshot = await setup();
    const cachedAt = now - 120_000;
    await deliver(base(snapshot.protocol, 1, { ts: cachedAt, la: 31.7 }));
    expect(peer()).toMatchObject({
      lastContactAt: now,
      lastLocAt: now,
      lastFixAt: cachedAt,
      positionUpdatedAt: cachedAt,
      fixApprox: true,
      fixAge: 120_000,
      positionStatus: 'stale'
    });

    await deliver(base(snapshot.protocol, 1, { id: 'carol', name: 'Carol', ts: now, la: 32.7 }));
    expect(peer('carol')).toMatchObject({ fixApprox: true, fixAge: 0, positionStatus: 'fresh' });

    await deliver(base(snapshot.protocol, 1, { id: 'dave', name: 'Dave', ft: 'invalid' }));
    expect(peer('dave')).toBeUndefined();
  });

  it('handles pause, resume, and leave without reviving an old fix', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { ft: now }));
    await deliver(statePacket(snapshot.protocol, 2, false));
    expect(peer()).toMatchObject({ networkStatus: 'online', positionStatus: 'paused' });
    await deliver(base(snapshot.protocol, 3, { ft: now - 1, la: 33.1, sh: true }));
    expect(peer()).toMatchObject({
      lat: 31.2, lon: 121.3, lastFixAt: now,
      networkStatus: 'online', positionStatus: 'paused'
    });

    advance(60_000);
    await deliver(statePacket(snapshot.protocol, 4, false));
    expect(peer()).toMatchObject({ networkStatus: 'online', positionStatus: 'paused' });
    await deliver(statePacket(snapshot.protocol, 5, true));
    expect(peer()).toMatchObject({ networkStatus: 'online', positionStatus: 'stale' });

    await deliver(base(snapshot.protocol, 6, { ft: now }));
    expect(peer()).toMatchObject({ positionStatus: 'fresh' });
    const fixAtLeave = peer().lastFixAt;
    await deliver(base(snapshot.protocol, 7, { k: 'bye' }));
    expect(peer()).toMatchObject({ networkStatus: 'left', positionStatus: 'fresh', lastFixAt: fixAtLeave });

    await deliver(base(snapshot.protocol, 8, { ft: now + 1_000, la: 33.7 }));
    expect(peer()).toMatchObject({ networkStatus: 'left', lastFixAt: fixAtLeave });
    await deliver(base(snapshot.protocol, 9, { k: 'hi' }));
    expect(peer()).toMatchObject({ networkStatus: 'online' });
  });

  it('ignores a queued geolocation callback from a previous meet session', async () => {
    const callbacks: Array<(position: any) => void> = [];
    vi.mocked(navigator.geolocation.watchPosition).mockImplementation((success: (position: any) => void) => {
      callbacks.push(success);
      return callbacks.length;
    });
    await setup();
    await meetModule.leaveMeet('switch');
    await meetModule.createMeetSession({ name: 'Alice' });
    meetModule.setMeetSharing(true);
    const before = { ...meetModule.getMeetSnapshot().self };
    const sends = harness.relay.send.mock.calls.length;

    callbacks[0]({
      coords: { latitude: 40, longitude: 116, accuracy: 5, heading: null, speed: null },
      timestamp: now
    });

    expect(meetModule.getMeetSnapshot().self).toEqual(before);
    expect(harness.relay.send).toHaveBeenCalledTimes(sends);
  });

  it('flags poor accuracy and sustained deterioration at explicit boundaries', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { ft: now, ac: 50 }));
    expect(peer().positionStatus).toBe('fresh');
    await deliver(base(snapshot.protocol, 2, { ft: now + 1, ac: 50.1 }));
    expect(peer()).toMatchObject({ positionStatus: 'weak', weakGpsReason: 'accuracy' });
    await deliver(base(snapshot.protocol, 3, { ft: now + 2, ac: 10 }));
    expect(peer().positionStatus).toBe('fresh');

    await deliver(base(snapshot.protocol, 1, { id: 'carol', name: 'Carol', ft: now, ac: 10 }));
    await deliver(base(snapshot.protocol, 2, { id: 'carol', name: 'Carol', ft: now + 1, ac: 20 }));
    await deliver(base(snapshot.protocol, 3, { id: 'carol', name: 'Carol', ft: now + 2, ac: 29.9 }));
    expect(peer('carol').positionStatus).toBe('fresh');
    await deliver(base(snapshot.protocol, 4, { id: 'carol', name: 'Carol', ft: now + 3, ac: 31 }));
    expect(peer('carol')).toMatchObject({ positionStatus: 'weak', weakGpsReason: 'deteriorating' });

    advance(60_003);
    expect(peer('carol').positionStatus).toBe('stale');
  });
});
