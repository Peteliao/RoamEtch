import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/core/chatImage';
import type { CachedOriginalImage } from '../src/core/originalImageCache';
import type { RtcSignalMessage } from '../src/core/rtcSignal';
import {
  P2PTransferError,
  P2PTransferManager,
  RTC_CHUNK_SIZE,
  RTC_CONNECT_TIMEOUT_MS,
  RTC_HIGH_WATER_MARK,
  RTC_IDLE_TIMEOUT_MS,
  type OutboundRtcSignal
} from '../src/core/webrtcTransfer';

class FakeDataChannel extends EventTarget {
  binaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState = 'connecting';
  label: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  peer: FakeDataChannel | null = null;
  duplicateEof = false;
  autoDrain = false;
  highWaterObserved = 0;
  receivedStrings = 0;

  constructor(label: string) {
    super();
    this.label = label;
  }

  send(data: unknown) {
    if (this.readyState !== 'open') throw new Error('channel-not-open');
    const size = typeof data === 'string' ? data.length : data instanceof ArrayBuffer ? data.byteLength : 0;
    this.bufferedAmount += size;
    this.highWaterObserved = Math.max(this.highWaterObserved, this.bufferedAmount);
    if (!this.peer) return;
    const copy = data instanceof ArrayBuffer ? data.slice(0) : data;
    const duplicate = typeof data === 'string' && data.includes('"file-eof"') && this.peer.duplicateEof;
    queueMicrotask(() => {
      this.peer?.onmessage?.({ data: copy });
      if (typeof copy === 'string' && this.peer) this.peer.receivedStrings++;
      if (duplicate) queueMicrotask(() => {
        this.peer?.onmessage?.({ data: copy });
        if (this.peer) this.peer.receivedStrings++;
      });
    });
    if (this.autoDrain && this.bufferedAmount > RTC_HIGH_WATER_MARK) {
      queueMicrotask(() => {
        if (this.readyState === 'open') this.drain();
      });
    }
  }

  drain() {
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event('bufferedamountlow'));
  }

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

class FakePeerConnection extends EventTarget {
  connectionState = 'new';
  iceConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  channels: FakeDataChannel[] = [];
  candidates: RTCIceCandidateInit[] = [];
  closeCalls = 0;
  restartIceCalls = 0;
  onicecandidate: ((event: { candidate: { toJSON: () => RTCIceCandidateInit } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;

  constructor(private network: FakeNetwork) {
    super();
    network.peers.push(this);
  }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\no=- test-offer\r\n' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\no=- test-answer\r\n' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
    if (description.type === 'answer') this.network.connect(this);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.candidates.push(candidate);
  }

  restartIce() {
    this.restartIceCalls++;
  }

  close() {
    this.closeCalls++;
    this.connectionState = 'closed';
    for (const channel of this.channels) channel.close();
  }
}

class FakeNetwork {
  peers: FakePeerConnection[] = [];
  duplicateEof: boolean;
  autoDrain: boolean;

  constructor(duplicateEof = false, autoDrain = false) {
    this.duplicateEof = duplicateEof;
    this.autoDrain = autoDrain;
  }

  create(config: RTCConfiguration) {
    return new FakePeerConnection(this) as unknown as RTCPeerConnection;
  }

  connect(peer: FakePeerConnection) {
    if (peer.channels[0]?.peer) return;
    const other = this.peers.find((entry) => entry !== peer);
    if (!peer.channels[0] || !other) return;
    const remote = new FakeDataChannel(peer.channels[0].label);
    other.channels.push(remote);
    peer.channels[0].peer = remote;
    remote.peer = peer.channels[0];
    remote.duplicateEof = this.duplicateEof;
    peer.channels[0].autoDrain = this.autoDrain;
    remote.autoDrain = this.autoDrain;
    other.ondatachannel?.({ channel: remote });
    queueMicrotask(() => {
      for (const pc of [peer, other]) {
        pc.connectionState = 'connected';
        pc.iceConnectionState = 'connected';
        pc.onconnectionstatechange?.();
      }
      peer.channels[0].open();
      remote.open();
    });
  }
}

type RoutedSignal = RtcSignalMessage;

function jpegBytes(size = RTC_CHUNK_SIZE * 2 + 123) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, 0x01, 0x40, 0x03]);
  for (let i = 12; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

async function original(fileId = 'original123', size?: number, hashOverride?: string): Promise<CachedOriginalImage> {
  const bytes = jpegBytes(size);
  return {
    fileId,
    blob: new Blob([bytes], { type: 'image/jpeg' }),
    size: bytes.length,
    mime: 'image/jpeg',
    width: 320,
    height: 512,
    sha256: hashOverride || await sha256Hex(bytes.buffer),
    createdAt: Date.now(),
    lastUsed: Date.now()
  };
}

function signal(from: string, to: string, outgoing: OutboundRtcSignal): RtcSignalMessage {
  return {
    kind: 'rtc-signal',
    msgId: outgoing.msgId,
    sessionId: outgoing.sessionId,
    fromPeerId: from,
    toPeerId: to,
    type: outgoing.type,
    ts: Date.now(),
    payload: outgoing.payload
  };
}

function managers(network: FakeNetwork, holderOriginals: CachedOriginalImage[] = [], holderEnabled = true) {
  const holderOutbox: RoutedSignal[] = [];
  const receiverOutbox: RoutedSignal[] = [];
  const holderSignals: RoutedSignal[] = [];
  const receiverSignals: RoutedSignal[] = [];
  const holder = new P2PTransferManager({
    selfId: 'alice',
    enabled: () => holderEnabled,
    iceServers: () => [],
    publish: async (outgoing) => {
      const routed = signal('alice', 'bob', outgoing);
      holderSignals.push(routed);
      holderOutbox.push(routed);
      return true;
    },
    getOriginal: (fileId) => holderOriginals.find((entry) => entry.fileId === fileId) || null,
    createPeerConnection: (config) => network.create(config)
  });
  const receiver = new P2PTransferManager({
    selfId: 'bob',
    enabled: () => true,
    iceServers: () => [],
    publish: async (outgoing) => {
      const routed = signal('bob', 'alice', outgoing);
      receiverSignals.push(routed);
      receiverOutbox.push(routed);
      return true;
    },
    getOriginal: () => null,
    createPeerConnection: (config) => network.create(config)
  });
  const routeOne = async (target: P2PTransferManager, outbox: RoutedSignal[]) => {
    const routed = outbox.shift();
    if (routed) await target.handleSignal(routed);
    return !!routed;
  };
  const flush = async () => {
    while (true) {
      await Promise.resolve();
      if (!holderOutbox.length && !receiverOutbox.length) return;
      const routed = holderOutbox.shift() || receiverOutbox.shift();
      if (!routed) continue;
      await (routed.fromPeerId === 'alice' ? receiver : holder).handleSignal(routed);
    }
  };
  return { holder, receiver, holderOutbox, receiverOutbox, holderSignals, receiverSignals, routeOne, flush };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  while (cleanups.length) cleanups.pop()!();
});

describe('WebRTC original transfer', () => {
  it('completes a fixed-offerer handshake and verifies a multi-chunk original', async () => {
    const cached = await original();
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const progress: number[] = [];
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height,
      onProgress: (value) => progress.push(value)
    });
    await pair.flush();
    const blob = await pending;
    expect(blob.size).toBe(cached.size);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await cached.blob.arrayBuffer()));
    expect(progress.at(-1)).toBe(100);
    expect(pair.holderSignals.some((entry) => entry.type === 'offer')).toBe(true);
    expect(pair.receiverSignals.some((entry) => entry.type === 'answer')).toBe(true);
  });

  it('queues ICE that arrives before the offer', async () => {
    const cached = await original();
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    await pair.routeOne(pair.holder, pair.receiverOutbox);
    const holderPc = network.peers[0];
    const candidate = { candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 5000 typ host', sdpMid: '0' };
    holderPc.onicecandidate?.({ candidate: { toJSON: () => candidate } });
    const ice = pair.holderOutbox.find((entry) => entry.type === 'ice');
    expect(ice).toBeTruthy();
    pair.holderOutbox.splice(pair.holderOutbox.indexOf(ice!), 1);
    await pair.receiver.handleSignal(ice!);
    expect(network.peers[1]).toBeUndefined();
    await pair.flush();
    await pending;
    expect(network.peers[1].candidates).toEqual([candidate]);
  });

  it('restarts ICE once when the first connection fails before the answer arrives', async () => {
    const cached = await original();
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    await pair.routeOne(pair.holder, pair.receiverOutbox);
    await pair.routeOne(pair.receiver, pair.holderOutbox);
    const holderPc = network.peers[0];
    holderPc.iceConnectionState = 'failed';
    holderPc.oniceconnectionstatechange?.();
    holderPc.connectionState = 'failed';
    holderPc.onconnectionstatechange?.();
    await vi.waitFor(() => expect(pair.holderSignals.filter((entry) => entry.type === 'offer')).toHaveLength(2));
    expect(holderPc.restartIceCalls).toBe(1);

    await pair.routeOne(pair.receiver, pair.holderOutbox);
    const answers = pair.receiverOutbox.filter((entry) => entry.type === 'answer');
    const freshAnswer = answers.at(-1)!;
    pair.receiverOutbox.splice(pair.receiverOutbox.indexOf(freshAnswer), 1);
    await pair.holder.handleSignal(freshAnswer);
    await pair.flush();
    expect((await pending).size).toBe(cached.size);
  });

  it('reports a remote ICE timeout instead of a user cancellation', async () => {
    const cached = await original();
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await pair.receiver.handleSignal(signal('alice', 'bob', {
      msgId: 'remote-abort', sessionId: (pair.receiver as any).sessions.keys().next().value,
      toPeerId: 'bob', type: 'abort',
      payload: { fileId: cached.fileId, reason: 'ice-timeout' }
    }));
    await rejected;
  });

  it('ignores a duplicate EOF while checksum verification is pending', async () => {
    const cached = await original();
    const network = new FakeNetwork(true);
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    await pair.flush();
    expect((await pending).size).toBe(cached.size);
    expect(network.peers[1].channels[0].receivedStrings).toBeGreaterThanOrEqual(3);
  });

  it('rejects a checksum mismatch without resolving a corrupt blob', async () => {
    const cached = await original('original123', undefined, '0'.repeat(64));
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'checksum' });
    await pair.flush();
    await rejected;
  });

  it('applies SCTP backpressure above the high watermark', async () => {
    const cached = await original('original123', RTC_CHUNK_SIZE * 40);
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    await pair.flush();
    const channel = network.peers[0].channels[0];
    await vi.waitFor(() => expect(channel.bufferedAmount).toBeGreaterThan(RTC_HIGH_WATER_MARK));
    channel.autoDrain = true;
    channel.drain();
    expect((await pending).size).toBe(cached.size);
    expect(channel.highWaterObserved).toBeGreaterThan(RTC_HIGH_WATER_MARK);
  });

  it('rejects expired originals and privacy-disabled holders', async () => {
    const cached = await original();
    for (const [originals, enabled, code] of [
      [[], true, 'expired'],
      [[cached], false, 'privacy-disabled']
    ] as const) {
      const pair = managers(new FakeNetwork(), [...originals], enabled);
      cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
      const pending = pair.receiver.requestFile({
        peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
        mime: cached.mime, width: cached.width, height: cached.height
      });
      const rejected = expect(pending).rejects.toMatchObject({ code });
      await pair.flush();
      await rejected;
    }
  });

  it('limits the holder to two simultaneous sender sessions', async () => {
    const originals = await Promise.all([original('original001'), original('original002'), original('original003')]);
    const pair = managers(new FakeNetwork(), originals);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    for (let i = 0; i < 3; i++) {
      const cached = originals[i];
      await pair.holder.handleSignal(signal('bob', 'alice', {
        msgId: `request-${i}`, sessionId: `session-${i}`, toPeerId: 'bob', type: 'pull-req',
        payload: { fileId: cached.fileId, sha256: cached.sha256, size: cached.size }
      }));
    }
    expect(pair.holder.activeSendSessions).toBe(2);
    expect(pair.holderOutbox.at(-1)).toMatchObject({ type: 'pull-reject', payload: { reason: 'busy' } });
  });

  it('times out an unanswered request after ten seconds', async () => {
    vi.useFakeTimers();
    const cached = await original();
    const pair = managers(new FakeNetwork());
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(P2PTransferError);
    await vi.advanceTimersByTimeAsync(RTC_CONNECT_TIMEOUT_MS);
    await rejected;
    expect(pair.receiverOutbox.at(-1)).toMatchObject({ type: 'abort', payload: { reason: 'ice-timeout' } });
  });

  it('closes completed peer connections after thirty idle seconds', async () => {
    vi.useFakeTimers();
    const cached = await original();
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    await pair.flush();
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    const sessionId = (pair.receiver as any).sessions.keys().next().value;
    expect((pair.holder as any).sessions.get(sessionId)?.state).toBe('complete');
    await vi.advanceTimersByTimeAsync(RTC_IDLE_TIMEOUT_MS);
    expect(network.peers.every((peer) => peer.closeCalls > 0)).toBe(true);
  });

  it('rejects oversized requests before creating a session', async () => {
    const pair = managers(new FakeNetwork());
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    await expect(pair.receiver.requestFile({
      peerId: 'alice', fileId: 'original123', sha256: 'A'.repeat(64), size: 32 * 1024 * 1024 + 1,
      mime: 'image/jpeg', width: 320, height: 512
    })).rejects.toMatchObject({ code: 'protocol' });
    expect(pair.receiverOutbox).toHaveLength(0);
  });

  it.each([0, RTC_CHUNK_SIZE - 1])('rejects an invalid %i-byte non-final chunk', async (size) => {
    const cached = await original();
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'protocol' });
    const transfer = (pair.receiver as any).sessions.values().next().value;
    transfer.state = 'connected';
    transfer.meta = {
      type: 'file-meta', fileId: cached.fileId, name: 'original.jpg', mime: cached.mime,
      size: cached.size, width: cached.width, height: cached.height,
      totalChunks: Math.ceil(cached.size / RTC_CHUNK_SIZE), sha256: cached.sha256
    };
    await (pair.receiver as any).receiveChunk(transfer, new ArrayBuffer(size));
    await rejected;
    expect((pair.receiver as any).sessions.size).toBe(0);
  });

  it.each(['mime', 'width', 'height'] as const)('rejects file metadata whose %s differs from the request', async (field) => {
    const cached = await original();
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'protocol' });
    const transfer = (pair.receiver as any).sessions.values().next().value;
    transfer.state = 'connected';
    await (pair.receiver as any).handleChannelMessage(transfer, JSON.stringify({
      type: 'file-meta', fileId: cached.fileId, name: 'original.jpg', mime: cached.mime,
      size: cached.size, width: cached.width, height: cached.height,
      totalChunks: Math.ceil(cached.size / RTC_CHUNK_SIZE), sha256: cached.sha256,
      [field]: field === 'mime' ? 'image/png' : field === 'width' ? cached.width + 1 : cached.height + 1
    }));
    await rejected;
    expect((pair.receiver as any).sessions.size).toBe(0);
  });

  it('keeps the connect deadline until the data channel opens', async () => {
    vi.useFakeTimers();
    const cached = await original();
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(P2PTransferError);
    await pair.routeOne(pair.holder, pair.receiverOutbox);
    const holderPc = network.peers[0];
    holderPc.connectionState = 'connected';
    holderPc.onconnectionstatechange?.();
    expect(pair.holder.activeSendSessions).toBe(1);
    await vi.advanceTimersByTimeAsync(RTC_CONNECT_TIMEOUT_MS);
    await rejected;
    expect(pair.holder.activeSendSessions).toBe(0);
    expect(holderPc.closeCalls).toBeGreaterThan(0);
  });

  it('times out a transfer stalled by SCTP backpressure', async () => {
    vi.useFakeTimers();
    const cached = await original('original123', RTC_CHUNK_SIZE * 40);
    const network = new FakeNetwork();
    const pair = managers(network, [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(P2PTransferError);
    await pair.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(network.peers[0].channels[0].bufferedAmount).toBeGreaterThan(RTC_HIGH_WATER_MARK);
    await vi.advanceTimersByTimeAsync(RTC_IDLE_TIMEOUT_MS);
    await rejected;
    expect(network.peers.every((peer) => peer.closeCalls > 0)).toBe(true);
  });

  it('closes and rejects a cancelled request synchronously', async () => {
    const cached = await original();
    const pair = managers(new FakeNetwork(), [cached]);
    cleanups.push(() => { pair.holder.close(); pair.receiver.close(); });
    const pending = pair.receiver.requestFile({
      peerId: 'alice', fileId: cached.fileId, sha256: cached.sha256, size: cached.size,
      mime: cached.mime, width: cached.width, height: cached.height
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'aborted' });
    pair.receiver.cancelFile('alice', cached.fileId, cached.sha256);
    expect((pair.receiver as any).sessions.size).toBe(0);
    expect(pair.receiverOutbox.at(-1)).toMatchObject({ type: 'abort' });
    await rejected;
  });
});
