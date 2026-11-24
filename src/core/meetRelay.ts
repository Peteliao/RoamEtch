// Blind relay transports for live meetups. The relay only forwards opaque
// AES-256-GCM envelopes; it never receives the invite secret or plaintext
// positions. The topic/path contains only the public random room id.
import { get } from './settings';
import { MEET_MAX_PACKET_CHARS } from './meetLink';

export type RelayState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';
export type RelayHandlers = {
  onMessage: (text: string) => void;
  onState: (state: RelayState, detail?: any) => void;
};

export type MeetRelay = {
  connect: () => void;
  send: (text: string) => boolean;
  close: () => void;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX_FRAME_CHARS = MEET_MAX_PACKET_CHARS;

/** Public WSS endpoints are used together; whichever answers first wins the race. */
export const PUBLIC_MQTT_URLS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://mqtt-dashboard.com:8884/mqtt'
] as const;

const LEGACY_PUBLIC_MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u16(n: number) {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function utf8Field(value: string) {
  const body = enc.encode(value);
  if (body.length > 0xffff) throw new Error('mqtt-field-too-long');
  return concat([u16(body.length), body]);
}

function varint(n: number) {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Uint8Array.from(out);
}

export function parseMqttFrameHeader(buf: Uint8Array) {
  if (buf.length < 2) return null;
  let mult = 1;
  let len = 0;
  let i = 1;
  while (i < buf.length && i <= 4) {
    const b = buf[i++];
    len += (b & 0x7f) * mult;
    if (!(b & 0x80)) {
      const total = i + len;
      return total > MAX_FRAME_CHARS ? { error: 'mqtt-frame-too-large' } : { headerLen: i, total };
    }
    mult *= 128;
  }
  return i >= 5 ? { error: 'mqtt-length' } : null;
}

export function validateMqttPacket(raw: Uint8Array, headerLen: number): string | null {
  if (headerLen < 1 || headerLen > raw.length) return 'mqtt-frame';
  const type = raw[0] >> 4;
  const flags = raw[0] & 0x0f;
  const body = raw.slice(headerLen);
  if (type === 2) return flags === 0 && body.length === 2 ? null : 'mqtt-connack';
  if (type === 9) {
    // SUBACK always carries a packet id plus at least one grant byte.
    if (flags !== 0 || body.length < 3) return 'mqtt-control';
    return ((body[0] << 8) | body[1]) ? null : 'mqtt-control';
  }
  if (type === 3) {
    if (body.length < 2) return 'mqtt-publish';
    const topicLen = (body[0] << 8) | body[1];
    if (!topicLen || body.length < 2 + topicLen) return 'mqtt-publish';
    const qos = (flags >> 1) & 3;
    if (qos > 1) return 'mqtt-qos';
    if (qos === 1) {
      const at = 2 + topicLen;
      if (body.length < at + 2 || !((body[at] << 8) | body[at + 1])) return 'mqtt-publish';
    }
    return null;
  }
  if ([4, 5, 7, 11].includes(type)) return flags === 0 && body.length === 2 ? null : 'mqtt-control';
  if (type === 6) return flags === 2 && body.length === 2 ? null : 'mqtt-control';
  if ([13, 14].includes(type)) return flags === 0 && body.length === 0 ? null : 'mqtt-control';
  return 'mqtt-packet-type';
}

function packet(type: number, flags: number, payload: Uint8Array) {
  return concat([Uint8Array.of((type << 4) | flags), varint(payload.length), payload]);
}

function mqttConnectPacket(clientId: string) {
  return packet(1, 0, concat([
    utf8Field('MQTT'),
    Uint8Array.of(4, 0x02),
    u16(45),
    utf8Field(clientId)
  ]));
}

function mqttSubscribePacket(packetId: number, topic: string) {
  return packet(8, 2, concat([u16(packetId), utf8Field(topic), Uint8Array.of(0)]));
}

function mqttPublishPacket(topic: string, body: string) {
  const bytes = enc.encode(body);
  return packet(3, 0, concat([utf8Field(topic), bytes]));
}

function mqttPubAck(packetId: number) {
  return packet(4, 0, u16(packetId));
}

function randomClientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'tm' + [...bytes].map((b) => b.toString(36)).join('').slice(0, 18);
}

export function publicMqttUrls() {
  const configured = String(get('meetMqttUrl') || '').trim();
  if (configured && configured !== LEGACY_PUBLIC_MQTT_URL) return [configured];
  return [...PUBLIC_MQTT_URLS];
}

function topicFor(roomId: string) {
  const prefix = String(get('meetMqttPrefix') || 'trackmint/v2/meet').trim().replace(/^\/+|\/+$/g, '');
  return `${prefix || 'trackmint/v2/meet'}/${roomId}`;
}

class MqttRelay implements MeetRelay {
  handlers: RelayHandlers;
  url: string;
  topic: string;
  ws: any = null;
  buf = new Uint8Array(0);
  connected = false;
  closed = false;
  attempt = 0;
  reconnectTimer: any = null;
  connectTimer: any = null;
  keepAliveTimer: any = null;
  lastRx = 0;
  packetId = 1;

  constructor(topic: string, handlers: RelayHandlers, url: string) {
    this.topic = topic;
    this.handlers = handlers;
    this.url = url;
    this.handlers.onState('connecting');
    this.connect();
  }

  connect() {
    if (this.closed) return;
    if (!/^wss?:\/\//i.test(this.url)) {
      this.handlers.onState('error', { reason: 'mqtt-url' });
      return;
    }
    this.connected = false;
    this.buf = new Uint8Array(0);
    this.handlers.onState(this.attempt ? 'reconnecting' : 'connecting');
    let ws: any;
    try {
      ws = new WebSocket(this.url, ['mqtt']);
    } catch {
      this.handlers.onState('error', { reason: 'mqtt-open' });
      this.reconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.connectTimer = setTimeout(() => {
      if (!this.connected && this.ws === ws) {
        try { ws.close(); } catch { /* already closed */ }
      }
    }, 12000);
    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      ws.send(mqttConnectPacket(randomClientId()));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = Date.now();
      const data = ev.data;
      if (data instanceof ArrayBuffer) this.feed(new Uint8Array(data));
      else if (typeof data === 'string') this.feed(enc.encode(data));
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const wasConnected = this.connected;
      this.connected = false;
      this.ws = null;
      clearTimeout(this.connectTimer);
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      if (this.closed) { this.handlers.onState('closed'); return; }
      this.handlers.onState(wasConnected || this.attempt ? 'reconnecting' : 'error');
      this.reconnect();
    };
  }

  feed(chunk: Uint8Array) {
    if (this.closed) return;
    if (this.buf.length + chunk.length > MAX_FRAME_CHARS) {
      this.failProtocol('mqtt-frame-too-large');
      return;
    }
    this.buf = concat([this.buf, chunk]);
    for (;;) {
      const header = parseMqttFrameHeader(this.buf);
      if (!header) return;
      if ('error' in header) {
        this.failProtocol(header.error);
        return;
      }
      if (this.buf.length < header.total) return;
      const raw = this.buf.slice(0, header.total);
      this.buf = this.buf.slice(header.total);
      this.handlePacket(raw, header.headerLen);
      if (this.closed) return;
    }
  }

  failProtocol(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.buf = new Uint8Array(0);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.keepAliveTimer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close?.(1002, reason); } catch { try { ws?.terminate?.(); } catch { /* already closed */ } }
    this.handlers.onState('error', { reason });
  }

  handlePacket(raw: Uint8Array, headerLen: number) {
    const protocolError = validateMqttPacket(raw, headerLen);
    if (protocolError) { this.failProtocol(protocolError); return; }
    const type = raw[0] >> 4;
    const flags = raw[0] & 0x0f;
    const body = raw.slice(headerLen);
    if (type === 2) {
      const rc = body[1];
      if (rc !== 0) {
        this.handlers.onState('error', { reason: 'connack', code: rc });
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      }
      this.connected = true;
      this.attempt = 0;
      clearTimeout(this.connectTimer);
      this.ws?.send(mqttSubscribePacket(this.nextPacketId(), this.topic));
      this.lastRx = Date.now();
      this.startKeepAlive();
      this.handlers.onState('connected');
      return;
    }
    if (type === 3) {
      let at = 0;
      if (body.length < 2) { this.failProtocol('mqtt-publish'); return; }
      const topicLen = (body[at] << 8) | body[at + 1];
      at += 2;
      if (!topicLen || body.length < at + topicLen) { this.failProtocol('mqtt-publish'); return; }
      const topic = dec.decode(body.slice(at, at + topicLen));
      at += topicLen;
      const qos = (flags >> 1) & 3;
      if (qos === 3) { this.failProtocol('mqtt-qos'); return; }
      let pid = 0;
      if (qos > 0) {
        if (body.length < at + 2) { this.failProtocol('mqtt-publish'); return; }
        pid = (body[at] << 8) | body[at + 1];
        at += 2;
      }
      const text = dec.decode(body.slice(at));
      if (topic === this.topic && text.length > MAX_FRAME_CHARS) {
        this.failProtocol('mqtt-payload-too-large');
        return;
      }
      if (topic === this.topic && text) this.handlers.onMessage(text);
      if (qos === 1 && pid) this.ws?.send(mqttPubAck(pid));
      return;
    }
    if (![4, 5, 6, 7, 9, 11, 13, 14].includes(type)) this.failProtocol('mqtt-packet-type');
  }

  nextPacketId() {
    this.packetId = (this.packetId % 0xffff) + 1;
    return this.packetId;
  }

  startKeepAlive() {
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastRx > 90000) {
        try { this.ws?.close(); } catch { /* ignore */ }
        return;
      }
      try { this.ws?.send(packet(12, 0, new Uint8Array(0))); } catch { /* close handles it */ }
    }, 30000);
  }

  reconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.attempt++;
    const wait = Math.min(30000, 1200 * 2 ** Math.min(5, this.attempt - 1)) + Math.random() * 600;
    this.handlers.onState('reconnecting', { retryIn: wait });
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  send(text: string) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return false;
    try {
      const frame = mqttPublishPacket(this.topic, text);
      if (frame.length > MAX_FRAME_CHARS) return false;
      this.ws.send(frame);
      return true;
    } catch {
      return false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    clearInterval(this.keepAliveTimer);
    try {
      if (this.ws?.readyState === 1) {
        this.ws.send(packet(14, 0, new Uint8Array(0)));
        this.ws.close();
      }
    } catch { /* ignore */ }
    this.ws = null;
    this.connected = false;
    this.handlers.onState('closed');
  }
}

type MqttEntry = { url: string; state: RelayState; relay: MqttRelay | null };

class PublicMqttRelay implements MeetRelay {
  handlers: RelayHandlers;
  entries: MqttEntry[] = [];
  closed = false;
  lastState: RelayState | '' = '';

  constructor(topic: string, handlers: RelayHandlers, urls: string[]) {
    this.handlers = handlers;
    for (const url of urls) {
      const entry: MqttEntry = { url, state: 'connecting', relay: null };
      this.entries.push(entry);
      entry.relay = new MqttRelay(topic, {
        onMessage: (text) => {
          if (!this.closed) this.handlers.onMessage(text);
        },
        onState: (state, detail) => {
          entry.state = state;
          this.emitAggregate(state === 'connected', state === 'error' ? detail?.reason : undefined);
        }
      }, url);
    }
    this.emitAggregate(false);
  }

  private emitAggregate(childConnected = false, errorReason?: string) {
    if (this.closed) return;
    const states = this.entries.map((e) => e.state);
    let next: RelayState;
    if (states.includes('connected')) next = 'connected';
    else if (states.includes('connecting')) next = 'connecting';
    else if (states.includes('reconnecting')) next = 'reconnecting';
    else if (states.includes('error')) next = 'error';
    else next = 'closed';
    if (next === this.lastState && !(next === 'connected' && childConnected)) return;
    this.lastState = next;
    this.handlers.onState(next, errorReason ? { reason: errorReason } : undefined);
  }

  connect() {
    for (const entry of this.entries) entry.relay?.connect();
  }

  send(text: string) {
    let sent = false;
    for (const entry of this.entries) {
      if (entry.state === 'connected' && entry.relay?.send(text)) sent = true;
    }
    return sent;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries) {
      try { entry.relay?.close(); } catch { /* already closed */ }
    }
    this.handlers.onState('closed');
  }
}

class WebSocketRelay implements MeetRelay {
  handlers: RelayHandlers;
  template: string;
  roomId: string;
  ws: any = null;
  closed = false;
  attempt = 0;
  reconnectTimer: any = null;

  constructor(roomId: string, handlers: RelayHandlers) {
    this.roomId = roomId;
    this.handlers = handlers;
    this.template = String(get('meetWsUrl') || '').trim();
    if (!this.template || !/\{room\}/.test(this.template) || !/^wss?:\/\//i.test(this.template)) {
      this.handlers.onState('error', { reason: 'ws-url' });
      return;
    }
    this.handlers.onState('connecting');
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const url = this.template.replace('{room}', encodeURIComponent(this.roomId));
    this.handlers.onState(this.attempt ? 'reconnecting' : 'connecting');
    let ws: any;
    try {
      ws = new WebSocket(url);
    } catch {
      this.handlers.onState('error', { reason: 'ws-open' });
      this.reconnect();
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.closed || this.ws !== ws) return;
      this.attempt = 0;
      this.handlers.onState('connected');
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const data = ev.data;
      if (typeof data === 'string') {
        if (data.length && data.length <= MAX_FRAME_CHARS) this.handlers.onMessage(data);
      } else if (data instanceof ArrayBuffer) {
        if (data.byteLength && data.byteLength <= MAX_FRAME_CHARS) this.handlers.onMessage(dec.decode(new Uint8Array(data)));
      } else if (data instanceof Blob && data.size <= MAX_FRAME_CHARS) {
        data.text().then((text) => {
          if (this.ws === ws && text) this.handlers.onMessage(text);
        }).catch(() => { /* ignore malformed frame */ });
      }
    };
    ws.onerror = () => { /* close follows */ };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) { this.handlers.onState('closed'); return; }
      this.handlers.onState('reconnecting');
      this.reconnect();
    };
  }

  reconnect() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    this.attempt++;
    const wait = Math.min(30000, 1200 * 2 ** Math.min(5, this.attempt - 1)) + Math.random() * 600;
    this.reconnectTimer = setTimeout(() => this.connect(), wait);
  }

  send(text: string) {
    if (!this.ws || this.ws.readyState !== 1 || text.length > MAX_FRAME_CHARS) return false;
    try { this.ws.send(text); return true; } catch { return false; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.handlers.onState('closed');
  }
}

export function createMeetRelay(roomId: string, handlers: RelayHandlers): MeetRelay {
  if (get('meetRelayMode') === 'ws') return new WebSocketRelay(roomId, handlers);
  const urls = publicMqttUrls();
  if (urls.length === 1) return new MqttRelay(topicFor(roomId), handlers, urls[0]);
  return new PublicMqttRelay(topicFor(roomId), handlers, urls);
}

/** Reserved for the future WebRTC transport; exposes the locally stored ICE config. */
export function readMeetIceConfig() {
  const stun = String(get('meetStun') || '').trim();
  const turn = String(get('meetTurnUrl') || '').trim();
  const iceServers: any[] = [];
  if (stun) iceServers.push({ urls: stun });
  if (turn) {
    iceServers.push({
      urls: turn,
      username: String(get('meetTurnUser') || ''),
      credential: String(get('meetTurnPass') || '')
    });
  }
  return { iceServers } as RTCConfiguration;
}
