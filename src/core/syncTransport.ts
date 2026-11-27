// WebRTC data-channel transport for cross-device sync.
// The pairing QR supplies an out-of-band secret; the blind relay only sees
// encrypted signaling envelopes. Trip records never touch the relay once the
// authenticated peer channel is open.
import { get } from './settings';
import { buildIceServers } from './webrtcConfig';
import { createMeetRelay, publicMqttUrls, type MeetRelay, type RelayOptions, type RelayState } from './meetRelay';
import {
  createSyncHello, deriveSyncSignalKey, inviteFingerprint, isSelfInvite, openSyncSignal, sealSyncSignal,
  verifySyncHello, verifySyncInvite, type SyncDeviceIdentity
} from './syncIdentity';
import type { SyncChannel } from './syncEngine';
import type { SyncPairingInvite, SyncPeerIdentity, SyncWireMessage } from './syncProtocol';

const CONNECT_TIMEOUT_MS = 90_000;
const SIGNAL_MAX_CHARS = 120 * 1024;
const DATA_CHUNK_CHARS = 48_000;
const DATA_MAX_CHARS = 16 * 1024 * 1024;
const BUFFER_HIGH = 1024 * 1024;
const BUFFER_LOW = 256 * 1024;
const FRAME_HEAD = /^S\|(\d{1,10})\|(\d{1,5})\|(\d{1,5})\|/;

export type SyncTransportPhase =
  | 'relay-connecting' | 'relay-connected' | 'waiting' | 'signaling'
  | 'connecting' | 'connected' | 'relay-retry';

export interface SyncTransportStatus {
  phase: SyncTransportPhase;
  reason?: string;
}

export class SyncTransportError extends Error {
  code: string;
  detail?: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'SyncTransportError';
    this.code = code;
    this.detail = detail;
  }
}

export interface SyncConnection {
  channel: SyncChannel;
  peer: SyncPeerIdentity;
  close(): void;
}

export interface ConnectSyncOptions {
  invite: SyncPairingInvite;
  identity: SyncDeviceIdentity;
  role: 'initiator' | 'responder';
  signal?: AbortSignal;
  timeoutMs?: number;
  onStatus?: (status: SyncTransportStatus) => void;
  relayOptions?: RelayOptions;
  iceConfig?: RTCConfiguration;
}

type SignalPayload =
  | { kind: 'ready'; hello: any }
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; from: 'initiator' | 'responder'; candidate: any }
  | { kind: 'bye' };

export function syncRelayOptions(): RelayOptions {
  const configuredUrl = String(get('syncMqttUrl') || '').trim();
  return {
    mode: get('syncRelayMode') === 'ws' ? 'ws' : 'mqtt',
    mqttUrls: publicMqttUrls(configuredUrl),
    mqttPrefix: String(get('syncMqttPrefix') || 'roametch/v2/sync'),
    wsUrl: String(get('syncWsUrl') || '')
  };
}

export function syncIceConfig(): RTCConfiguration {
  return {
    iceServers: buildIceServers({
      stun: String(get('syncStun') || ''),
      turnUrl: String(get('syncTurnUrl') || ''),
      turnUser: String(get('syncTurnUser') || ''),
      turnPass: String(get('syncTurnPass') || '')
    }),
    iceCandidatePoolSize: 4
  };
}

function abortError() {
  return new SyncTransportError('sync-aborted');
}

function relayErrorCode(reason?: string) {
  if (reason === 'mqtt-url' || reason === 'ws-url' || reason === 'mqtt-open' || reason === 'ws-open') {
    return 'sync-relay-config';
  }
  return 'sync-relay-blocked';
}

export async function connectSyncPeer(options: ConnectSyncOptions): Promise<SyncConnection> {
  const { invite, identity, role, signal } = options;
  if (!await verifySyncInvite(invite) || Date.now() > invite.exp) {
    return Promise.reject(new SyncTransportError('sync-pair-expired'));
  }
  if (role === 'responder' && isSelfInvite(invite, identity)) {
    return Promise.reject(new SyncTransportError('sync-self'));
  }
  if (typeof RTCPeerConnection === 'undefined') {
    return Promise.reject(new SyncTransportError('sync-unsupported'));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise<SyncConnection>((resolve, reject) => {
    let settled = false;
    let relay: MeetRelay | null = null;
    let pc: RTCPeerConnection | null = null;
    let dataChannel: DataChannelSync | null = null;
    let signalKey: CryptoKey | null = null;
    let peer: SyncPeerIdentity | null = null;
    let offerSdp = '';
    let answerSdp = '';
    let relayReady = false;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let gatherTimer: ReturnType<typeof setTimeout> | null = null;
    let lastOffer = '';
    let lastAnswer = '';
    const queuedCandidates: any[] = [];
    let remoteDescriptionSet = false;

    const timeout = setTimeout(() => fail(new SyncTransportError('sync-timeout')), options.timeoutMs ?? CONNECT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = null;
      if (gatherTimer) clearTimeout(gatherTimer);
      gatherTimer = null;
      signal?.removeEventListener('abort', onAbort);
      try { relay?.close(); } catch { /* already closed */ }
      relay = null;
      if (pc) {
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.ondatachannel = null;
      }
    };

    const fail = (error: SyncTransportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { pc?.close(); } catch { /* already closed */ }
      pc = null;
      dataChannel?.detach();
      reject(error);
    };

    const succeed = () => {
      if (settled || !dataChannel || !peer) return;
      settled = true;
      cleanup();
      options.onStatus?.({ phase: 'connected' });
      resolve({
        channel: dataChannel,
        peer,
        close: () => {
          try { dataChannel?.close(); } catch { /* already closed */ }
          try { pc?.close(); } catch { /* already closed */ }
          pc = null;
        }
      });
    };

    const onAbort = () => fail(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });

    const sendSignal = async (body: SignalPayload) => {
      if (settled || !relayReady || !relay || !signalKey) return false;
      const text = await sealSyncSignal(signalKey, { sid: invite.sid, ...body });
      if (text.length > SIGNAL_MAX_CHARS) throw new SyncTransportError('sync-signal');
      return relay.send(text);
    };

    const sendReady = async () => {
      if (!signalKey || role !== 'responder' || settled) return;
      try {
        const hello = await createSyncHello(identity, invite, 'responder');
        await sendSignal({ kind: 'ready', hello });
      } catch (error) {
        fail(asTransportError(error, 'sync-signal'));
      }
    };

    const startRetry = () => {
      if (retryTimer) clearInterval(retryTimer);
      retryTimer = setInterval(async () => {
        if (settled || !relayReady) return;
        try {
          if (role === 'responder') {
            if (answerSdp) await sendSignal({ kind: 'answer', sdp: answerSdp });
            else await sendReady();
          } else if (offerSdp) {
            await sendSignal({ kind: 'offer', sdp: offerSdp });
          }
        } catch (error) {
          fail(asTransportError(error, 'sync-signal'));
        }
      }, 3000);
    };

    const attachChannel = (channel: RTCDataChannel) => {
      if (settled) return;
      if (dataChannel) {
        channel.close();
        return;
      }
      dataChannel = new DataChannelSync(channel, (reason) => {
        if (!settled) fail(new SyncTransportError(reason || 'sync-disconnected'));
      });
      if (channel.readyState === 'open') succeed();
      else channel.addEventListener('open', () => succeed(), { once: true });
    };

    const newPeerConnection = () => {
      const connection = new RTCPeerConnection(options.iceConfig ?? syncIceConfig());
      connection.onicecandidate = (event) => {
        if (!event.candidate || settled) return;
        const candidate = typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON() : event.candidate;
        void sendSignal({ kind: 'ice', from: role, candidate }).catch(() => { /* relay may be reconnecting */ });
      };
      connection.onconnectionstatechange = () => {
        if (settled) return;
        if (connection.connectionState === 'failed') fail(new SyncTransportError('sync-nat'));
        else if (connection.connectionState === 'disconnected') {
          options.onStatus?.({ phase: 'relay-retry', reason: 'ice-disconnected' });
        }
      };
      pc = connection;
      return connection;
    };

    const flushCandidates = async (connection: RTCPeerConnection) => {
      remoteDescriptionSet = true;
      while (queuedCandidates.length) {
        const candidate = queuedCandidates.shift();
        try { await connection.addIceCandidate(candidate); } catch { /* stale candidate */ }
      }
    };

    const waitForGathering = (connection: RTCPeerConnection, limit = 6000) => {
      if (connection.iceGatheringState === 'complete') return Promise.resolve();
      return new Promise<void>((done) => {
        const finish = () => {
          connection.removeEventListener('icegatheringstatechange', check);
          if (gatherTimer) clearTimeout(gatherTimer);
          gatherTimer = null;
          done();
        };
        const check = () => { if (connection.iceGatheringState === 'complete') finish(); };
        connection.addEventListener('icegatheringstatechange', check);
        gatherTimer = setTimeout(finish, limit);
      });
    };

    const handleHostSignal = async (message: SignalPayload) => {
      if (role !== 'initiator') return;
      if (message.kind === 'ready') {
        if (!peer) {
          const verified = await verifySyncHello(invite, message.hello, 'responder');
          if (!verified) throw new SyncTransportError('sync-peer');
          if (verified.deviceId === identity.deviceId) throw new SyncTransportError('sync-self');
          peer = verified;
          options.onStatus?.({ phase: 'signaling' });
          const connection = newPeerConnection();
          const channel = connection.createDataChannel('roametch-sync', { ordered: true });
          attachChannel(channel);
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          await waitForGathering(connection);
          offerSdp = connection.localDescription?.sdp || offer.sdp || '';
          await sendSignal({ kind: 'offer', sdp: offerSdp });
          lastOffer = offerSdp;
          startRetry();
          return;
        }
        if (offerSdp) await sendSignal({ kind: 'offer', sdp: offerSdp });
        return;
      }
      if (!peer || !pc) return;
      if (message.kind === 'answer') {
        if (typeof message.sdp !== 'string' || message.sdp.length > 96 * 1024) {
          throw new SyncTransportError('sync-signal');
        }
        if (message.sdp === lastAnswer) return;
        lastAnswer = message.sdp;
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
          await flushCandidates(pc);
          options.onStatus?.({ phase: 'connecting' });
        }
        return;
      }
      if (message.kind === 'ice' && message.from === 'responder') {
        if (remoteDescriptionSet && pc.remoteDescription) {
          try { await pc.addIceCandidate(message.candidate); } catch { /* stale */ }
        } else {
          queuedCandidates.push(message.candidate);
        }
      }
    };

    const handleGuestSignal = async (message: SignalPayload) => {
      if (role !== 'responder') return;
      if (message.kind === 'offer') {
        if (typeof message.sdp !== 'string' || message.sdp.length > 96 * 1024) {
          throw new SyncTransportError('sync-signal');
        }
        if (message.sdp === lastOffer) {
          if (answerSdp) await sendSignal({ kind: 'answer', sdp: answerSdp });
          return;
        }
        lastOffer = message.sdp;
        if (!pc) {
          const connection = newPeerConnection();
          connection.ondatachannel = (event) => attachChannel(event.channel);
          pc = connection;
        }
        options.onStatus?.({ phase: 'signaling' });
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        await flushCandidates(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitForGathering(pc);
        answerSdp = pc.localDescription?.sdp || answer.sdp || '';
        await sendSignal({ kind: 'answer', sdp: answerSdp });
        options.onStatus?.({ phase: 'connecting' });
        startRetry();
        return;
      }
      if (message.kind === 'ice' && message.from === 'initiator') {
        if (remoteDescriptionSet && pc?.remoteDescription) {
          try { await pc.addIceCandidate(message.candidate); } catch { /* stale */ }
        } else {
          queuedCandidates.push(message.candidate);
        }
      }
    };

    const onRelayReady = async () => {
      if (settled) return;
      relayReady = true;
      options.onStatus?.({ phase: role === 'initiator' ? 'waiting' : 'signaling' });
      try {
        if (role === 'responder') await sendReady();
        startRetry();
      } catch (error) {
        fail(asTransportError(error, 'sync-signal'));
      }
    };

    const start = async () => {
      if (role === 'responder') {
        peer = {
          deviceId: invite.deviceId,
          name: invite.name,
          publicJwk: invite.jwk,
          fingerprint: await inviteFingerprint(invite)
        };
      }
      try {
        signalKey = await deriveSyncSignalKey(invite);
      } catch {
        fail(new SyncTransportError('sync-crypto'));
        return;
      }
      if (settled) return;
      relay = createMeetRelay(invite.room, {
        onMessage: (text) => {
          if (settled || !signalKey) return;
          void (async () => {
            const opened = await openSyncSignal(signalKey!, text);
            if (!opened || opened.sid !== invite.sid) return;
            if (opened.kind === 'bye') { fail(new SyncTransportError('sync-disconnected')); return; }
            const message = opened as SignalPayload;
            if (role === 'initiator') await handleHostSignal(message);
            else await handleGuestSignal(message);
          })().catch((error) => fail(asTransportError(error, 'sync-signal')));
        },
        onState: (state: RelayState, detail) => {
          if (settled) return;
          if (state === 'connected') {
            if (!relayReady) void onRelayReady();
          } else if (state === 'connecting') {
            options.onStatus?.({ phase: 'relay-connecting' });
          } else if (state === 'reconnecting') {
            relayReady = false;
            options.onStatus?.({ phase: 'relay-retry', reason: detail?.reason });
          } else if (state === 'error') {
            relayReady = false;
            fail(new SyncTransportError(relayErrorCode(detail?.reason), detail?.reason));
          }
        }
      }, options.relayOptions ?? syncRelayOptions());
    };

    void start();
  });
}

function asTransportError(error: any, fallback: string) {
  if (error instanceof SyncTransportError) return error;
  return new SyncTransportError(fallback);
}

/** Fragments JSON messages into ordered text frames so large track chunks stay
 * below browser SCTP message limits, and applies backpressure. */
class DataChannelSync implements SyncChannel {
  private dc: RTCDataChannel;
  private handler: ((message: SyncWireMessage) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private closed = false;
  private outgoing: Promise<void> = Promise.resolve();
  private incoming: { id: number; total: number; next: number; parts: string[]; size: number } | null = null;
  private nextId = 1;
  private onFatal: (reason: string) => void;

  constructor(channel: RTCDataChannel, onFatal: (reason: string) => void) {
    this.dc = channel;
    this.onFatal = onFatal;
    this.dc.binaryType = 'arraybuffer';
    this.dc.bufferedAmountLowThreshold = BUFFER_LOW;
    this.dc.onmessage = (event) => this.receive(event.data);
    this.dc.onclose = () => this.handleClose('sync-disconnected');
    this.dc.onerror = () => { /* close follows */ };
  }

  send(message: SyncWireMessage) {
    if (this.closed) return Promise.reject(new SyncTransportError('sync-disconnected'));
    const text = JSON.stringify(message);
    if (!text || text.length > DATA_MAX_CHARS) {
      return Promise.reject(new SyncTransportError('sync-limit'));
    }
    const id = this.nextId++;
    this.outgoing = this.outgoing.then(() => this.writeFrames(id, text));
    return this.outgoing;
  }

  private async writeFrames(id: number, text: string) {
    const total = Math.max(1, Math.ceil(text.length / DATA_CHUNK_CHARS));
    if (total > 10_000) throw new SyncTransportError('sync-limit');
    for (let index = 0; index < total; index++) {
      if (this.closed || this.dc.readyState !== 'open') throw new SyncTransportError('sync-disconnected');
      if (this.dc.bufferedAmount > BUFFER_HIGH) await this.waitWritable();
      this.dc.send(`S|${id}|${index}|${total}|${text.slice(index * DATA_CHUNK_CHARS, (index + 1) * DATA_CHUNK_CHARS)}`);
    }
  }

  private waitWritable() {
    if (this.closed || this.dc.readyState !== 'open') return Promise.reject(new SyncTransportError('sync-disconnected'));
    if (this.dc.bufferedAmount <= BUFFER_LOW) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dc.removeEventListener('bufferedamountlow', low);
        reject(new SyncTransportError('sync-timeout'));
      }, 30_000);
      const low = () => {
        clearTimeout(timer);
        this.dc.removeEventListener('bufferedamountlow', low);
        if (this.closed) reject(new SyncTransportError('sync-disconnected'));
        else resolve();
      };
      this.dc.addEventListener('bufferedamountlow', low, { once: true });
    });
  }

  private receive(data: any) {
    if (this.closed) return;
    if (typeof data !== 'string') {
      // Binary frames are outside the sync protocol.
      this.handleClose('sync-protocol');
      return;
    }
    const match = FRAME_HEAD.exec(data);
    if (!match) {
      this.handleClose('sync-protocol');
      return;
    }
    const id = Number(match[1]);
    const index = Number(match[2]);
    const total = Number(match[3]);
    const body = data.slice(match[0].length);
    if (total < 1 || total > 10_000 || index >= total) {
      this.handleClose('sync-protocol');
      return;
    }
    if (!this.incoming || this.incoming.id !== id) {
      // Ordered data means a new id can only start after the previous message.
      if (this.incoming && this.incoming.id > id) return;
      this.incoming = { id, total, next: 0, parts: [], size: 0 };
    }
    if (this.incoming.total !== total || this.incoming.next !== index) {
      this.handleClose('sync-protocol');
      return;
    }
    this.incoming.size += body.length;
    if (this.incoming.size > DATA_MAX_CHARS) {
      this.handleClose('sync-limit');
      return;
    }
    this.incoming.parts.push(body);
    this.incoming.next++;
    if (this.incoming.next < total) return;
    const text = this.incoming.parts.join('');
    this.incoming = null;
    let parsed: SyncWireMessage;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.handleClose('sync-protocol');
      return;
    }
    this.handler?.(parsed);
  }

  private handleClose(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.(reason);
    this.onFatal(reason);
  }

  setMessageHandler(handler: (message: SyncWireMessage) => void) {
    this.handler = handler;
  }

  onClose(handler: (reason?: string) => void) {
    this.closeHandler = handler;
  }

  detach() {
    this.closed = true;
    this.dc.onmessage = null;
    this.dc.onclose = null;
    this.dc.onerror = null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.dc.close(); } catch { /* already closed */ }
    this.closeHandler?.('closed');
  }
}
