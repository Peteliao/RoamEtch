import {
  LOCAL_IMAGE_MAX_BYTES,
  LOCAL_IMAGE_MAX_PIXELS,
  ORIGINAL_IMAGE_MIMES,
  readLocalImageHeader,
  sha256Hex
} from './chatImage';
import type { CachedOriginalImage, OriginalImageMeta } from './originalImageCache';
import { randomMeetId } from './meetLink';
import type { RtcRejectReason, RtcSignalMessage, RtcSignalPayload, RtcSignalType } from './rtcSignal';

export const RTC_DATA_CHANNEL_LABEL = 'trackmint-file';
export const RTC_CHUNK_SIZE = 16 * 1024;
export const RTC_HIGH_WATER_MARK = 256 * 1024;
export const RTC_LOW_WATER_MARK = 64 * 1024;
export const RTC_CONNECT_TIMEOUT_MS = 10_000;
export const RTC_IDLE_TIMEOUT_MS = 30_000;
export const RTC_MAX_SEND_SESSIONS = 2;

export type P2PErrorCode =
  | 'unsupported'
  | 'disabled'
  | 'offline'
  | 'expired'
  | 'busy'
  | 'privacy-disabled'
  | 'timeout'
  | 'aborted'
  | 'checksum'
  | 'protocol'
  | 'closed';

export class P2PTransferError extends Error {
  constructor(public code: P2PErrorCode) {
    super(code);
    this.name = 'P2PTransferError';
  }
}

export type OutboundRtcSignal = {
  msgId: string;
  sessionId: string;
  toPeerId: string;
  type: RtcSignalType;
  payload: RtcSignalPayload;
};

export type P2PTransferOptions = {
  selfId: string;
  enabled: () => boolean;
  iceServers: () => RTCIceServer[];
  publish: (signal: OutboundRtcSignal) => Promise<boolean>;
  getOriginal: (fileId: string) => CachedOriginalImage | null;
  onProgress?: (event: { peerId: string; fileId: string; sha256: string; progress: number }) => void;
  onError?: (event: { peerId: string; fileId: string; sha256: string; code: P2PErrorCode }) => void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
};

export type RequestOriginalInput = OriginalImageMeta & {
  peerId: string;
  onProgress?: (progress: number) => void;
};

type FileMeta = OriginalImageMeta & {
  type: 'file-meta';
  name: string;
  totalChunks: number;
};

type TransferSession = {
  id: string;
  peerId: string;
  fileId: string;
  sha256: string;
  size: number;
  mime: string;
  width: number;
  height: number;
  role: 'sender' | 'receiver';
  state: 'requesting' | 'connecting' | 'connected' | 'transferring' | 'awaiting-ack' | 'verifying' | 'complete';
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  original: CachedOriginalImage | null;
  remoteReady: boolean;
  offerSent: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  localCandidates: RTCIceCandidateInit[];
  connectTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  meta: FileMeta | null;
  transferStarted: boolean;
  closed: boolean;
  settled: boolean;
  resolve: ((blob: Blob) => void) | null;
  reject: ((error: P2PTransferError) => void) | null;
  promise: Promise<Blob> | null;
  onProgress: ((progress: number) => void) | null;
};

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validMeta(meta: Record<string, any>, expected: Pick<RequestOriginalInput, 'fileId' | 'sha256' | 'size' | 'mime' | 'width' | 'height'>) {
  return meta.type === 'file-meta'
    && meta.fileId === expected.fileId
    && meta.sha256 === expected.sha256
    && meta.size === expected.size
    && meta.mime === expected.mime
    && ORIGINAL_IMAGE_MIMES.includes(meta.mime)
    && meta.width === expected.width && Number.isInteger(meta.width) && meta.width > 0
    && meta.height === expected.height && Number.isInteger(meta.height) && meta.height > 0
    && meta.width * meta.height <= LOCAL_IMAGE_MAX_PIXELS
    && meta.totalChunks === Math.ceil(meta.size / RTC_CHUNK_SIZE)
    && typeof meta.name === 'string' && meta.name.length > 0 && meta.name.length <= 128;
}

export function webrtcAvailable() {
  return typeof globalThis.RTCPeerConnection === 'function';
}

export class P2PTransferManager {
  private sessions = new Map<string, TransferSession>();
  private peerConnectionFactory: (config: RTCConfiguration) => RTCPeerConnection;

  constructor(private options: P2PTransferOptions) {
    this.peerConnectionFactory = options.createPeerConnection || ((config) => new globalThis.RTCPeerConnection(config));
  }

  requestFile(input: RequestOriginalInput) {
    if (!this.options.enabled()) return Promise.reject(new P2PTransferError('disabled'));
    if (!webrtcAvailable() && !this.options.createPeerConnection) return Promise.reject(new P2PTransferError('unsupported'));
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.peerId) || input.peerId === this.options.selfId
      || !/^[A-Za-z0-9_-]{8,64}$/.test(input.fileId)
      || !/^[A-Fa-f0-9]{64}$/.test(input.sha256)
      || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > LOCAL_IMAGE_MAX_BYTES
      || !ORIGINAL_IMAGE_MIMES.includes(input.mime)
      || !Number.isInteger(input.width) || !Number.isInteger(input.height)
      || input.width <= 0 || input.height <= 0 || input.width * input.height > LOCAL_IMAGE_MAX_PIXELS) {
      return Promise.reject(new P2PTransferError('protocol'));
    }
    const existing = [...this.sessions.values()].find((session) => session.role === 'receiver'
      && session.peerId === input.peerId && session.fileId === input.fileId
      && session.sha256.toLowerCase() === input.sha256.toLowerCase() && session.size === input.size
      && session.mime === input.mime && session.width === input.width && session.height === input.height);
    if (existing) return existing.promise!;
    let resolve!: (blob: Blob) => void;
    let reject!: (error: P2PTransferError) => void;
    const promise = new Promise<Blob>((res, rej) => { resolve = res; reject = rej; });
    const session: TransferSession = {
      id: randomMeetId(),
      peerId: input.peerId,
      fileId: input.fileId,
      sha256: input.sha256,
      size: input.size,
      mime: input.mime,
      width: input.width,
      height: input.height,
      role: 'receiver',
      state: 'requesting',
      pc: null,
      dc: null,
      original: null,
      remoteReady: false,
      offerSent: false,
      pendingCandidates: [],
      localCandidates: [],
      connectTimer: null,
      idleTimer: null,
      chunks: [],
      receivedBytes: 0,
      meta: null,
      transferStarted: false,
      closed: false,
      settled: false,
      resolve,
      reject,
      promise,
      onProgress: input.onProgress || null
    };
    this.sessions.set(session.id, session);
    this.armConnectTimeout(session);
    void this.sendSignal(session, 'pull-req', { fileId: input.fileId, sha256: input.sha256, size: input.size }).then((sent) => {
      if (!sent && !session.closed) this.failSession(session, 'offline');
    });
    return promise;
  }

  cancelFile(peerId: string, fileId: string, sha256?: string) {
    const session = [...this.sessions.values()].find((entry) => entry.peerId === peerId
      && entry.fileId === fileId && entry.role === 'receiver'
      && (!sha256 || entry.sha256.toLowerCase() === sha256.toLowerCase()));
    if (!session || session.closed) return;
    void this.sendSignal(session, 'abort', { fileId });
    this.failSession(session, 'aborted');
  }

  async handleSignal(signal: RtcSignalMessage) {
    if (signal.fromPeerId === this.options.selfId || signal.toPeerId !== this.options.selfId) return;
    if (signal.type === 'pull-req') {
      await this.handlePullRequest(signal);
      return;
    }
    const session = this.sessions.get(signal.sessionId);
    if (!session || session.closed || session.peerId !== signal.fromPeerId) return;
    if (signal.type === 'pull-reject') {
      if (session.role !== 'receiver' || signal.payload.fileId !== session.fileId) return;
      const reason = signal.payload.reason;
      this.failSession(session, reason === 'expired' ? 'expired' : reason === 'busy' ? 'busy' : reason === 'ice-timeout' ? 'timeout' : 'privacy-disabled');
      return;
    }
    if (signal.type === 'abort') {
      if (signal.payload.fileId && signal.payload.fileId !== session.fileId) return;
      if (session.state === 'complete') this.closeSession(session);
      else this.failSession(session, 'aborted');
      return;
    }
    if (signal.type === 'offer') {
      await this.handleOffer(session, signal);
      return;
    }
    if (signal.type === 'answer') {
      await this.handleAnswer(session, signal);
      return;
    }
    if (signal.type === 'ice') {
      await this.handleCandidate(session, signal.payload.candidate!);
    }
  }

  close() {
    for (const session of [...this.sessions.values()]) this.closeSession(session);
  }

  closePeer(peerId: string) {
    for (const session of [...this.sessions.values()]) {
      if (session.peerId === peerId) this.closeSession(session);
    }
  }

  get activeSendSessions() {
    return [...this.sessions.values()].filter((session) => session.role === 'sender' && !session.closed).length;
  }

  private async handlePullRequest(signal: RtcSignalMessage) {
    const payload = signal.payload;
    if (!payload.fileId || !payload.sha256 || !payload.size) return;
    if (!this.options.enabled()) {
      await this.sendSignalTo(signal.fromPeerId, 'pull-reject', { fileId: payload.fileId, reason: 'privacy-disabled' }, signal.sessionId);
      return;
    }
    const original = this.options.getOriginal(payload.fileId);
    if (!original || original.sha256 !== payload.sha256 || original.size !== payload.size) {
      await this.sendSignalTo(signal.fromPeerId, 'pull-reject', { fileId: payload.fileId, reason: 'expired' }, signal.sessionId);
      return;
    }
    const existing = [...this.sessions.values()].find((session) => session.role === 'sender' && session.peerId === signal.fromPeerId && session.fileId === payload.fileId && !session.closed);
    if (existing) return;
    if (this.activeSendSessions >= RTC_MAX_SEND_SESSIONS || this.sessions.has(signal.sessionId)) {
      await this.sendSignalTo(signal.fromPeerId, 'pull-reject', { fileId: payload.fileId, reason: 'busy' }, signal.sessionId);
      return;
    }
    let session: TransferSession;
    try {
      session = this.createSenderSession(signal.fromPeerId, original, signal.sessionId);
    } catch {
      await this.sendSignalTo(signal.fromPeerId, 'pull-reject', { fileId: payload.fileId, reason: 'busy' }, signal.sessionId);
      return;
    }
    const pc = session.pc!;
    session.original = original;
    session.state = 'connecting';
    try {
      const channel = pc.createDataChannel(RTC_DATA_CHANNEL_LABEL, { ordered: true });
      this.attachChannel(session, channel);
      const offer = await pc.createOffer();
      if (session.closed) return;
      await pc.setLocalDescription(offer);
      if (session.closed) return;
      const sent = await this.sendSignal(session, 'offer', { sdp: { type: 'offer', sdp: pc.localDescription?.sdp || offer.sdp || '' } });
      if (session.closed) return;
      if (!sent) {
        this.failSession(session, 'offline');
        return;
      }
      session.offerSent = true;
      for (const candidate of session.localCandidates.splice(0)) {
        if (session.closed) return;
        await this.sendSignal(session, 'ice', { candidate });
      }
    } catch {
      this.failSession(session, 'protocol');
    }
  }

  private async handleOffer(session: TransferSession, signal: RtcSignalMessage) {
    if (session.role !== 'receiver' || session.state !== 'requesting' || !signal.payload.sdp) return;
    let pc: RTCPeerConnection;
    try {
      pc = this.attachPeer(session);
    } catch {
      this.failSession(session, 'unsupported');
      return;
    }
    session.state = 'connecting';
    pc.ondatachannel = (event) => {
      if (session.closed) return;
      if (event.channel.label !== RTC_DATA_CHANNEL_LABEL || session.dc) {
        this.failSession(session, 'protocol', true);
        return;
      }
      this.attachChannel(session, event.channel);
    };
    try {
      await pc.setRemoteDescription(signal.payload.sdp);
      if (session.closed) return;
      session.remoteReady = true;
      await this.flushCandidates(session);
      if (session.closed) return;
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (session.closed) return;
      const sent = await this.sendSignal(session, 'answer', { sdp: { type: 'answer', sdp: pc.localDescription?.sdp || answer.sdp || '' } });
      if (!sent) this.failSession(session, 'offline');
    } catch {
      this.failSession(session, 'protocol', true);
    }
  }

  private async handleAnswer(session: TransferSession, signal: RtcSignalMessage) {
    if (session.role !== 'sender' || session.remoteReady || !signal.payload.sdp) return;
    try {
      await session.pc!.setRemoteDescription(signal.payload.sdp);
      if (session.closed) return;
      session.remoteReady = true;
      await this.flushCandidates(session);
    } catch {
      this.failSession(session, 'protocol', true);
    }
  }

  private async handleCandidate(session: TransferSession, candidate: RTCIceCandidateInit) {
    if (!session.remoteReady) {
      if (session.pendingCandidates.length >= 32) {
        this.failSession(session, 'protocol');
        return;
      }
      session.pendingCandidates.push(candidate);
      return;
    }
    if (!session.pc) return;
    try {
      await session.pc.addIceCandidate(candidate);
    } catch {
      this.failSession(session, 'protocol');
    }
  }

  private async flushCandidates(session: TransferSession) {
    const candidates = session.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      if (session.closed) return;
      await session.pc!.addIceCandidate(candidate);
    }
  }

  private createSenderSession(peerId: string, original: CachedOriginalImage, sessionId: string) {
    const session: TransferSession = {
      id: sessionId,
      peerId,
      fileId: original.fileId,
      sha256: original.sha256,
      size: original.size,
      mime: original.mime,
      width: original.width,
      height: original.height,
      role: 'sender',
      state: 'connecting',
      pc: null,
      dc: null,
      original: null,
      remoteReady: false,
      offerSent: false,
      pendingCandidates: [],
      localCandidates: [],
      connectTimer: null,
      idleTimer: null,
      chunks: [],
      receivedBytes: 0,
      meta: null,
      transferStarted: false,
      closed: false,
      settled: true,
      resolve: null,
      reject: null,
      promise: null,
      onProgress: null
    };
    this.attachPeer(session);
    this.sessions.set(session.id, session);
    return session;
  }

  private attachPeer(session: TransferSession) {
    const pc = this.peerConnectionFactory({ iceServers: this.options.iceServers() });
    session.pc = pc;
    this.armConnectTimeout(session);
    pc.onicecandidate = (event) => {
      if (!event.candidate || session.closed) return;
      const candidate = event.candidate.toJSON();
      if (session.role === 'sender' && !session.offerSent) session.localCandidates.push(candidate);
      else void this.sendSignal(session, 'ice', { candidate });
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed') this.failSession(session, 'timeout', true, 'ice-timeout');
      else if (state === 'closed' && !session.closed) this.failSession(session, 'closed');
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') this.failSession(session, 'timeout', true, 'ice-timeout');
    };
    return pc;
  }

  private attachChannel(session: TransferSession, channel: RTCDataChannel) {
    session.dc = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = RTC_LOW_WATER_MARK;
    channel.onopen = () => {
      this.markConnected(session, true);
      if (session.role === 'sender' && !session.transferStarted) {
        session.transferStarted = true;
        void this.sendFile(session);
      }
    };
    channel.onmessage = (event) => { void this.handleChannelMessage(session, event.data); };
    channel.onerror = () => {
      if (!session.closed && session.state !== 'complete') this.failSession(session, 'closed');
    };
    channel.onclose = () => {
      if (!session.closed && session.state !== 'complete') this.failSession(session, 'closed');
    };
  }

  private markConnected(session: TransferSession, channelOpen: boolean) {
    if (!channelOpen || session.closed || session.state === 'complete') return;
    this.clearTimer(session.connectTimer);
    session.connectTimer = null;
    session.state = 'connected';
    this.armActivityTimeout(session);
  }

  private armConnectTimeout(session: TransferSession) {
    this.clearTimer(session.connectTimer);
    session.connectTimer = setTimeout(() => {
      if (!session.closed && session.state !== 'complete') this.failSession(session, 'timeout', true, 'ice-timeout');
    }, RTC_CONNECT_TIMEOUT_MS);
  }

  private armActivityTimeout(session: TransferSession) {
    if (session.closed || session.state === 'complete') return;
    this.clearTimer(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.closed && session.state !== 'complete') this.failSession(session, 'timeout');
    }, RTC_IDLE_TIMEOUT_MS);
  }

  private async sendFile(session: TransferSession) {
    const original = session.original;
    const channel = session.dc;
    if (!original || !channel || session.closed) return;
    try {
      const buffer = await original.blob.arrayBuffer();
      if (session.closed || channel.readyState !== 'open') throw new P2PTransferError('closed');
      const meta: FileMeta = {
        type: 'file-meta',
        fileId: original.fileId,
        name: `trackmint-${original.fileId}.${original.mime === 'image/png' ? 'png' : original.mime === 'image/webp' ? 'webp' : 'jpg'}`,
        mime: original.mime,
        size: original.size,
        width: original.width,
        height: original.height,
        totalChunks: Math.ceil(original.size / RTC_CHUNK_SIZE),
        sha256: original.sha256
      };
      session.state = 'transferring';
      this.armActivityTimeout(session);
      channel.send(JSON.stringify(meta));
      for (let offset = 0; offset < buffer.byteLength; offset += RTC_CHUNK_SIZE) {
        await this.waitForBuffer(session, channel);
        if (session.closed || channel.readyState !== 'open') throw new P2PTransferError('closed');
        const end = Math.min(offset + RTC_CHUNK_SIZE, buffer.byteLength);
        channel.send(buffer.slice(offset, end));
        this.reportProgress(session, Math.round(end / buffer.byteLength * 100));
        this.armActivityTimeout(session);
      }
      channel.send(JSON.stringify({ type: 'file-eof', fileId: original.fileId }));
      session.state = 'awaiting-ack';
      this.armActivityTimeout(session);
    } catch (error) {
      if (!session.closed) this.failSession(session, error instanceof P2PTransferError ? error.code : 'protocol');
    }
  }

  private waitForBuffer(session: TransferSession, channel: RTCDataChannel) {
    if (channel.bufferedAmount <= RTC_HIGH_WATER_MARK) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onError);
      };
      const onLow = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new P2PTransferError('closed')); };
      const onError = () => { cleanup(); reject(new P2PTransferError('closed')); };
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
      channel.addEventListener('error', onError);
      if (channel.bufferedAmount <= RTC_HIGH_WATER_MARK) onLow();
    });
  }

  private async handleChannelMessage(session: TransferSession, data: unknown) {
    if (typeof data !== 'string') {
      if (session.role !== 'receiver') {
        this.failSession(session, 'protocol');
        return;
      }
      await this.receiveChunk(session, data);
      return;
    }
    if (data.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data)) {
      this.failSession(session, 'protocol');
      return;
    }
    let message: any;
    try { message = JSON.parse(data); } catch {
      this.failSession(session, 'protocol');
      return;
    }
    if (!record(message) || typeof message.type !== 'string') {
      this.failSession(session, 'protocol');
      return;
    }
    if (message.type === 'file-meta') {
      if (session.role !== 'receiver' || session.meta || !validMeta(message, session)) {
        this.failSession(session, 'protocol');
        return;
      }
      session.meta = message as FileMeta;
      this.armActivityTimeout(session);
      return;
    }
    if (message.type === 'file-eof') {
      if (session.role !== 'receiver' || message.fileId !== session.fileId) {
        this.failSession(session, 'protocol');
        return;
      }
      await this.finishReceive(session);
      return;
    }
    if (message.type === 'file-ack') {
      if (session.role !== 'sender' || message.fileId !== session.fileId || message.sha256 !== session.sha256) {
        this.failSession(session, 'protocol');
        return;
      }
      session.state = 'complete';
      this.clearTimer(session.idleTimer);
      session.idleTimer = null;
      this.scheduleIdleClose(session);
      return;
    }
    this.failSession(session, 'protocol');
  }

  private async receiveChunk(session: TransferSession, data: unknown) {
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else {
      this.failSession(session, 'protocol');
      return;
    }
    if (!session.meta || session.state === 'verifying' || session.state === 'complete') {
      this.failSession(session, 'protocol');
      return;
    }
    const chunkIndex = session.chunks.length;
    const expectedSize = chunkIndex < session.meta.totalChunks - 1
      ? RTC_CHUNK_SIZE
      : session.size - chunkIndex * RTC_CHUNK_SIZE;
    if (chunkIndex >= session.meta.totalChunks || bytes.byteLength === 0
      || bytes.byteLength !== expectedSize || session.receivedBytes + bytes.byteLength > session.size) {
      this.failSession(session, 'protocol');
      return;
    }
    session.chunks.push(bytes.slice().buffer);
    session.receivedBytes += bytes.byteLength;
    this.reportProgress(session, Math.round(session.receivedBytes / session.size * 100));
    this.armActivityTimeout(session);
  }

  private async finishReceive(session: TransferSession) {
    if (session.state === 'verifying' || session.state === 'complete') return;
    if (!session.meta || session.receivedBytes !== session.size) {
      this.failSession(session, 'protocol');
      return;
    }
    session.state = 'verifying';
    this.armActivityTimeout(session);
    try {
      const blob = new Blob(session.chunks, { type: session.meta.mime });
      const hash = await sha256Hex(await blob.arrayBuffer());
      if (session.closed || session.state !== 'verifying') return;
      if (hash !== session.sha256) throw new P2PTransferError('checksum');
      const header = await readLocalImageHeader(blob);
      if (session.closed || session.state !== 'verifying') return;
      if (!header || header.mime !== session.meta.mime || header.width !== session.meta.width || header.height !== session.meta.height) {
        throw new P2PTransferError('protocol');
      }
      session.chunks = [];
      session.state = 'complete';
      this.reportProgress(session, 100);
      if (session.dc?.readyState === 'open') {
        session.dc.send(JSON.stringify({ type: 'file-ack', fileId: session.fileId, sha256: session.sha256 }));
      }
      session.settled = true;
      session.resolve?.(blob);
      this.scheduleIdleClose(session);
    } catch (error) {
      this.failSession(session, error instanceof P2PTransferError ? error.code : 'protocol');
    }
  }

  private reportProgress(session: TransferSession, progress: number) {
    session.onProgress?.(progress);
    if (session.role === 'receiver') this.options.onProgress?.({ peerId: session.peerId, fileId: session.fileId, sha256: session.sha256, progress });
  }

  private scheduleIdleClose(session: TransferSession) {
    this.clearTimer(session.connectTimer);
    session.connectTimer = null;
    this.clearTimer(session.idleTimer);
    session.idleTimer = setTimeout(() => this.closeSession(session), RTC_IDLE_TIMEOUT_MS);
  }

  private failSession(session: TransferSession, code: P2PErrorCode, notify = false, reason?: RtcRejectReason) {
    if (session.closed) return;
    if (notify) void this.sendSignal(session, 'abort', { fileId: session.fileId, ...(reason ? { reason } : {}) });
    const error = new P2PTransferError(code);
    if (!session.settled) {
      session.settled = true;
      session.reject?.(error);
    }
    this.closeSession(session);
    if (session.role === 'receiver') this.options.onError?.({ peerId: session.peerId, fileId: session.fileId, sha256: session.sha256, code });
  }

  private closeSession(session: TransferSession) {
    if (session.closed) return;
    session.closed = true;
    this.clearTimer(session.connectTimer);
    this.clearTimer(session.idleTimer);
    session.connectTimer = null;
    session.idleTimer = null;
    this.sessions.delete(session.id);
    if (session.dc) {
      session.dc.onopen = null;
      session.dc.onmessage = null;
      session.dc.onerror = null;
      session.dc.onclose = null;
      try { session.dc.close(); } catch { /* already closed */ }
    }
    if (session.pc) {
      session.pc.onicecandidate = null;
      session.pc.onconnectionstatechange = null;
      session.pc.oniceconnectionstatechange = null;
      session.pc.ondatachannel = null;
      try { session.pc.close(); } catch { /* already closed */ }
    }
    session.chunks = [];
    if (!session.settled) {
      session.settled = true;
      session.reject?.(new P2PTransferError('closed'));
    }
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null) {
    if (timer) clearTimeout(timer);
  }

  private sendSignal(session: TransferSession, type: RtcSignalType, payload: RtcSignalPayload) {
    return this.sendSignalTo(session.peerId, type, payload, session.id);
  }

  private async sendSignalTo(peerId: string, type: RtcSignalType, payload: RtcSignalPayload, sessionId: string) {
    try {
      return await this.options.publish({ msgId: randomMeetId(), sessionId, toPeerId: peerId, type, payload });
    } catch {
      return false;
    }
  }
}
