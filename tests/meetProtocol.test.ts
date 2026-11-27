import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEET_FEATURE_VERSION } from '../src/core/meetCollab';
import {
  decodeEpochSecret,
  deriveMeetPairwiseKey,
  generateMeetKeyPair,
  importMeetPublicKey,
  MEET_PROTOCOL_MAX,
  MEET_PROTOCOL_MIN,
  openMeetDirect,
  type MeetKeyPair
} from '../src/core/meetKeys';

async function pairwiseFor(keys: MeetKeyPair, peerPk: string, roomId: string, selfId: string, peerId: string) {
  const peerPublic = (await importMeetPublicKey(peerPk))!;
  return deriveMeetPairwiseKey(keys.privateKey, peerPublic, roomId, selfId, peerId);
}

function sentPackets(from = 0) {
  return harness.relay.send.mock.calls.slice(from).map(([text]: any) => JSON.parse(text));
}

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
let bobPk = '';

beforeAll(async () => {
  bobPk = (await generateMeetKeyPair()).publicB64;
});

function advance(ms: number) {
  now += ms;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await flush();
}

async function waitFor(check: () => boolean, timeoutMs = 2500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor-timeout');
}

async function deliver(packet: unknown) {
  harness.relayOptions.onMessage(JSON.stringify(packet));
  await settle(3);
}

function base(protocol: number, seq: number, overrides: any = {}) {
  return {
    k: 'loc', id: 'bob', name: 'Bob', c: '#5aa7f0', v: protocol,
    sq: seq, ts: now, la: 31.2, lo: 121.3, ac: 10, hd: null, sp: 0, sh: true,
    pv: MEET_FEATURE_VERSION, pmin: MEET_PROTOCOL_MIN, pmax: MEET_PROTOCOL_MAX,
    pk: bobPk, ep: 0,
    ...overrides
  };
}

async function joinPeer(protocol: number, id = 'bob', name = 'Bob', overrides: any = {}) {
  await deliver(base(protocol, 1, { k: 'hi', id, name, ...overrides }));
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
    await joinPeer(snapshot.protocol);
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
    await joinPeer(snapshot.protocol);
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
    await joinPeer(snapshot.protocol);
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
    await joinPeer(snapshot.protocol);
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
    await joinPeer(snapshot.protocol);
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

    await joinPeer(snapshot.protocol, 'carol', 'Carol');
    await deliver(base(snapshot.protocol, 1, { id: 'carol', name: 'Carol', ts: now, la: 32.7 }));
    expect(peer('carol')).toMatchObject({ fixApprox: true, fixAge: 0, positionStatus: 'fresh' });

    await deliver(base(snapshot.protocol, 1, { id: 'dave', name: 'Dave', ft: 'invalid' }));
    expect(peer('dave')).toBeUndefined();
  });

  it('handles pause, resume, and leave without reviving an old fix', async () => {
    const snapshot = await setup();
    await joinPeer(snapshot.protocol);
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

  it('shares temporary markers with bounded TTL and never revives or extends one', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { k: 'hi' }));
    await deliver(base(snapshot.protocol, 2, {
      k: 'mk', mkid: 'markerAA', mtyp: 'supply', tx: ' Water ', ttl: 999
    }));
    const created = meetModule.getMeetSnapshot().markers[0];
    expect(created).toMatchObject({
      id: 'markerAA', type: 'supply', label: 'Water', by: 'bob', byName: 'Bob', mine: false, ttlMin: 480
    });
    expect(created.remainingMs).toBe(480 * 60_000);

    await deliver(base(snapshot.protocol, 3, {
      k: 'mk', mkid: 'markerBB', mtyp: 'danger', ttl: 5
    }));
    await deliver(base(snapshot.protocol, 4, {
      k: 'mk', mkid: 'markerBB', mtyp: 'danger', ttl: 480
    }));
    const shortLived = meetModule.getMeetSnapshot().markers.find((m: any) => m.id === 'markerBB');
    expect(shortLived.remainingMs).toBe(5 * 60_000);

    await deliver(base(snapshot.protocol, 5, { k: 'mk', mkid: 'markerAA', del: true }));
    expect(meetModule.getMeetSnapshot().markers.map((m: any) => m.id)).toEqual(['markerBB']);

    advance(6 * 60_000);
    expect(meetModule.getMeetSnapshot().markers).toEqual([]);

    await deliver(base(snapshot.protocol, 6, {
      k: 'mk', id: 'nobody', name: 'Nobody', mkid: 'markerCC', mtyp: 'scenic', ttl: 30
    }));
    expect(meetModule.getMeetSnapshot().markers).toEqual([]);
  });

  it('lets only the host set the assembly goal and announces it in system chat', async () => {
    const snapshot = await setup();
    meetModule.injectMeetFix({ lat: 30.1, lon: 120.2, acc: 8, ts: now });
    await flush();
    const sendsBefore = harness.relay.send.mock.calls.length;
    expect(await meetModule.sendMeetGoal({ label: ' Ridge ' })).toBe(true);
    const goal = meetModule.getMeetSnapshot().goal;
    expect(goal).toMatchObject({ lat: 30.1, lon: 120.2, label: 'Ridge', by: snapshot.self.id, mine: true });
    const goalPacket = harness.relay.send.mock.calls.slice(sendsBefore)
      .map(([text]) => JSON.parse(text))
      .find((packet) => packet.k === 'goal');
    expect(goalPacket).toMatchObject({ k: 'goal', la: 30.1, lo: 120.2, tx: 'Ridge' });
    expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
      sys: 'goalSet', sysParams: { name: 'Alice', label: 'Ridge' }
    });

    await deliver(base(snapshot.protocol, 1, { k: 'hi' }));
    await deliver(base(snapshot.protocol, 2, {
      k: 'goal', id: 'bob', name: 'Bob', la: 31.9, lo: 121.9, tx: 'Hijack'
    }));
    expect(meetModule.getMeetSnapshot().goal).toMatchObject({ label: 'Ridge' });

    expect(await meetModule.clearMeetGoal()).toBe(true);
    expect(meetModule.getMeetSnapshot().goal).toBeNull();
    expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
      sys: 'goalCleared', sysParams: { name: 'Alice' }
    });
  });

  it('hard-rejects incompatible peers and keeps member notices for admitted ones', async () => {
    const snapshot = await setup();
    const events = await import('../src/core/events');
    const joined = vi.fn();
    const left = vi.fn();
    const incompatible = vi.fn();
    const offJoined = events.on('meet:peerjoined', joined);
    const offLeft = events.on('meet:peerleft', left);
    const offIncompatible = events.on('meet:incompatible', incompatible);
    try {
      await deliver(base(snapshot.protocol, 1, {
        k: 'hi', id: 'old', name: 'Old', pv: 3, pmin: 2, pmax: 2, pk: undefined
      }));
      expect(peer('old')).toBeUndefined();
      expect(incompatible).toHaveBeenCalledWith({ id: 'old', name: 'Old', reason: 'old' });
      expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
        sys: 'incompatible', sysParams: { name: 'Old' }
      });

      await deliver(base(snapshot.protocol, 2, {
        k: 'hi', id: 'future', name: 'Future', pv: 5, pmin: 4, pmax: 5
      }));
      expect(peer('future')).toBeUndefined();
      expect(incompatible).toHaveBeenLastCalledWith({ id: 'future', name: 'Future', reason: 'new' });

      await joinPeer(snapshot.protocol);
      expect(joined).toHaveBeenLastCalledWith({ name: 'Bob', id: 'bob', legacy: false });
      expect(peer()).toMatchObject({ protocolVersion: MEET_FEATURE_VERSION, legacy: false });
      expect(meetModule.getMeetSnapshot().legacyPeers).toBe(0);
      expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
        sys: 'join', sysParams: { name: 'Bob' }
      });

      await deliver(base(snapshot.protocol, 2, { k: 'bye' }));
      expect(left).toHaveBeenLastCalledWith({ id: 'bob', name: 'Bob' });
      expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
        sys: 'leave', sysParams: { name: 'Bob' }
      });

      await deliver(base(snapshot.protocol, 3, { k: 'hi' }));
      await meetModule.kickMeetPeer('bob');
      expect(left).toHaveBeenLastCalledWith({ id: 'bob', name: 'Bob', kicked: true });
      expect(meetModule.getMeetSnapshot().messages.at(-1)).toMatchObject({
        sys: 'kick', sysParams: { name: 'Bob' }
      });
      expect(meetModule.getMeetSnapshot().incompatiblePeers).toHaveLength(2);
    } finally {
      offJoined();
      offLeft();
      offIncompatible();
    }
  });

  it('rate-limits outgoing text and marks the peer capability version as current', async () => {
    const snapshot = await setup();
    await deliver(base(snapshot.protocol, 1, { k: 'hi', pv: MEET_FEATURE_VERSION }));
    expect(peer()).toMatchObject({ protocolVersion: MEET_FEATURE_VERSION, legacy: false });
    const events = await import('../src/core/events');
    const limited = vi.fn();
    const off = events.on('meet:ratelimited', limited);
    try {
      for (let i = 0; i < 8; i++) expect(await meetModule.sendMeetMessage(`m${i}`)).toBe(true);
      expect(await meetModule.sendMeetMessage('blocked')).toBe(false);
      expect(limited).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'text', retryAfterMs: expect.any(Number)
      }));
    } finally {
      off();
    }
  });

  it('publishes a signed invite lifetime and reports its expiry without ending the session', async () => {
    const snapshot = await setup();
    expect(snapshot.inviteExpiresAt).toBe(now + 24 * 60 * 60_000);
    expect(snapshot.inviteExpired).toBe(false);
    expect(snapshot.link).toMatch(/&iexp=\d+&isig=[A-Za-z0-9_-]{43}$/);
    advance(24 * 60 * 60_000);
    expect(meetModule.getMeetSnapshot().inviteExpired).toBe(true);
    expect(meetModule.getMeetSnapshot().active).toBe(true);
  });

  it('rejects expired or tampered signed invites before creating a session', async () => {
    const settings = await import('../src/core/settings');
    settings.set('meetP2PEnabled', false);
    meetModule = await import('../src/core/meet');
    const link = await import('../src/core/meetLink');
    const invite = link.generateMeetInvite();
    const past = now - 1_000;
    const expiredSig = await link.signMeetInviteExpiry(invite, past);
    await expect(meetModule.joinMeetSession(invite, {
      inviteExpiresAt: past, inviteSig: expiredSig
    })).rejects.toThrow('meet-invite-expired');

    const future = now + 60 * 60_000;
    const otherInvite = link.generateMeetInvite();
    const wrongSig = await link.signMeetInviteExpiry(otherInvite, future);
    await expect(meetModule.joinMeetSession(invite, {
      inviteExpiresAt: future, inviteSig: wrongSig
    })).rejects.toThrow('meet-invite-signature');
    expect(meetModule.getMeetSnapshot().active).toBe(false);
  });

  it('rotates the epoch on join and delivers the new secret through pairwise boxes', async () => {
    const snapshot = await setup();
    const bob = await generateMeetKeyPair();
    await deliver(base(snapshot.protocol, 1, {
      k: 'hello', id: 'bob', name: 'Bob', pk: bob.publicB64
    }));
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 1);
    await settle(4);

    const state = meetModule.getMeetSnapshot();
    expect(state.keyEpoch).toBe(1);
    expect(state.security).toMatchObject({ epoch: 1, rotated: true });
    expect(peer('bob')).toMatchObject({
      compatible: true, protocolVersion: MEET_FEATURE_VERSION, shareTo: true
    });

    const welcome = sentPackets().find((packet) => packet.k === 'dm' && packet.to === 'bob');
    expect(welcome).toBeTruthy();
    const hostId = state.self.id;
    const hostPk = String(welcome.pk);
    const key = await pairwiseFor(bob, hostPk, state.roomId, 'bob', hostId);
    const inner = await openMeetDirect(key, welcome.box);
    expect(inner).toMatchObject({ k: 'rekey', ep: 1, hostId });
    expect(inner.ids).toHaveLength(2);
    expect(inner.ids).toEqual(expect.arrayContaining([hostId, 'bob']));
    expect(decodeEpochSecret(inner.sec)).toHaveLength(32);
  });

  it('rotates for every admitted member and never sends the new epoch to a kicked peer', async () => {
    const snapshot = await setup();
    const bob = await generateMeetKeyPair();
    const carol = await generateMeetKeyPair();
    await deliver(base(snapshot.protocol, 1, {
      k: 'hello', id: 'bob', name: 'Bob', pk: bob.publicB64
    }));
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 1);
    await deliver(base(snapshot.protocol, 2, {
      k: 'hello', id: 'carol', name: 'Carol', pk: carol.publicB64
    }));
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 2);
    await settle(4);

    expect(await meetModule.kickMeetPeer('bob')).toBe(true);
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 3);
    await settle(4);
    const state = meetModule.getMeetSnapshot();
    expect(state.keyEpoch).toBe(3);
    expect(peer('bob')).toBeUndefined();
    expect(peer('carol')).toMatchObject({ compatible: true });

    const packets = sentPackets();
    const hostId = state.self.id;
    const bobBoxes = packets.filter((packet) => packet.k === 'dm' && packet.to === 'bob');
    const bobKey = await pairwiseFor(bob, String(bobBoxes[0].pk), state.roomId, 'bob', hostId);
    const bobEpochs: number[] = [];
    for (const packet of bobBoxes) {
      const inner = await openMeetDirect(bobKey, packet.box);
      if (inner) bobEpochs.push(Number(inner.ep));
    }
    expect(Math.max(...bobEpochs)).toBeLessThan(3);

    const carolBoxes = packets.filter((packet) => packet.k === 'dm' && packet.to === 'carol');
    const carolKey = await pairwiseFor(carol, String(carolBoxes.at(-1).pk), state.roomId, 'carol', hostId);
    const carolInner = await openMeetDirect(carolKey, carolBoxes.at(-1).box);
    expect(carolInner).toMatchObject({ k: 'rekey', ep: 3 });
  });

  it('sends locations pairwise when a teammate is hidden and restores direct sharing', async () => {
    const snapshot = await setup();
    const bob = await generateMeetKeyPair();
    const carol = await generateMeetKeyPair();
    await deliver(base(snapshot.protocol, 1, {
      k: 'hello', id: 'bob', name: 'Bob', pk: bob.publicB64
    }));
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 1);
    await deliver(base(snapshot.protocol, 2, {
      k: 'hello', id: 'carol', name: 'Carol', pk: carol.publicB64
    }));
    await waitFor(() => meetModule.getMeetSnapshot().keyEpoch === 2);
    await settle(4);
    const state = meetModule.getMeetSnapshot();
    expect(state.keyEpoch).toBe(2);

    expect(meetModule.setMeetPeerVisibility('bob', false)).toBe(true);
    expect(meetModule.getMeetSnapshot().peers.find((p: any) => p.id === 'bob'))
      .toMatchObject({ shareTo: false });
    harness.relay.send.mockClear();
    meetModule.injectMeetFix({ lat: 30.5, lon: 120.5, acc: 5, ts: now });
    await waitFor(() => sentPackets().some((packet) => packet.k === 'dm' && packet.to === 'carol'));

    const hidden = sentPackets();
    expect(hidden.some((packet) => packet.k === 'loc')).toBe(false);
    expect(hidden.some((packet) => packet.k === 'dm' && packet.to === 'bob')).toBe(false);
    const toCarol = hidden.filter((packet) => packet.k === 'dm' && packet.to === 'carol');
    const hostId = state.self.id;
    const carolKey = await pairwiseFor(carol, String(toCarol[0].pk), state.roomId, 'carol', hostId);
    const inner = await openMeetDirect(carolKey, toCarol[0].box);
    expect(inner).toMatchObject({ k: 'loc', la: 30.5, lo: 120.5 });

    expect(meetModule.setMeetPeerVisibility('bob', true)).toBe(true);
    await waitFor(() => sentPackets().some((packet) => packet.k === 'dm' && packet.to === 'bob'));
    const restored = sentPackets();
    const toBob = restored.filter((packet) => packet.k === 'dm' && packet.to === 'bob');
    const bobKey = await pairwiseFor(bob, String(toBob[0].pk), state.roomId, 'bob', hostId);
    expect(await openMeetDirect(bobKey, toBob[0].box)).toMatchObject({ k: 'loc', la: 30.5 });
  });

  it('announces room closure and rotates identity when the host resets the code', async () => {
    const snapshot = await setup();
    const bob = await generateMeetKeyPair();
    await deliver(base(snapshot.protocol, 1, {
      k: 'hello', id: 'bob', name: 'Bob', pk: bob.publicB64
    }));
    await settle(20);
    const before = sentPackets().length;
    const next = await meetModule.resetMeetCode();
    await settle(12);
    expect(next.invite).not.toBe(snapshot.invite);
    expect(next.keyEpoch).toBe(0);
    expect(next.peers).toEqual([]);
    expect(sentPackets(before).some((packet) => packet.k === 'closed')).toBe(true);
  });

  it('flags poor accuracy and sustained deterioration at explicit boundaries', async () => {
    const snapshot = await setup();
    await joinPeer(snapshot.protocol);
    await deliver(base(snapshot.protocol, 1, { ft: now, ac: 50 }));
    expect(peer().positionStatus).toBe('fresh');
    await deliver(base(snapshot.protocol, 2, { ft: now + 1, ac: 50.1 }));
    expect(peer()).toMatchObject({ positionStatus: 'weak', weakGpsReason: 'accuracy' });
    await deliver(base(snapshot.protocol, 3, { ft: now + 2, ac: 10 }));
    expect(peer().positionStatus).toBe('fresh');

    await joinPeer(snapshot.protocol, 'carol', 'Carol');
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
