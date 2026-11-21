// Blind relay transports for live meetups. The relay only forwards opaque
// AES-GCM envelopes; it never receives the room code or plaintext positions.
import { get } from './settings';

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

function baseMqttUrl() {
  return String(get('meetMqttUrl') || 'wss://broker.emqx.io:8084/mqtt').trim();
}

function topicFor(roomId: string) {
  const prefix = String(get('meetMqttPrefix') || 'trackmint/v1/meet').trim().replace(/^\/+|\/+$/g, '');
  return `${prefix || 'trackmint/v1/meet'}/${roomId}`;
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

  constructor(topic: string, handlers: RelayHandlers) {
    this.topic = topic;
    this.handlers = handlers;
    this.url = baseMqttUrl();
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
    this.buf = concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      let mult = 1;
      let len = 0;
      let i = 1;
      let complete = false;
      while (i < this.buf.length && i <= 4) {
        const b = this.buf[i++];
        len += (b & 0x7f) * mult;
        if (!(b & 0x80)) { complete = true; break; }
        mult *= 128;
      }
      if (!complete) return;
      const total = i + len;
      if (this.buf.length < total) return;
      const raw = this.buf.slice(0, total);
      this.buf = this.buf.slice(total);
      this.handlePacket(raw, i);
    }
  }

  handlePacket(raw: Uint8Array, headerLen: number) {
    const type = raw[0] >> 4;
    const flags = raw[0] & 0x0f;
    const body = raw.slice(headerLen);
    if (type === 2) {
      const rc = body[1] ?? 1;
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
      if (body.length < 2) return;
      const topicLen = (body[at] << 8) | body[at + 1];
      at += 2;
      if (body.length < at + topicLen) return;
      const topic = dec.decode(body.slice(at, at + topicLen));
      at += topicLen;
      const qos = (flags >> 1) & 3;
      let pid = 0;
      if (qos > 0) {
        if (body.length < at + 2) return;
        pid = (body[at] << 8) | body[at + 1];
        at += 2;
      }
      if (topic === this.topic) {
        const text = dec.decode(body.slice(at));
        if (text) this.handlers.onMessage(text);
      }
      if (qos === 1 && pid) this.ws?.send(mqttPubAck(pid));
    }
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
      this.ws.send(mqttPublishPacket(this.topic, text));
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
        if (data.length && data.length < 8192) this.handlers.onMessage(data);
      } else if (data instanceof ArrayBuffer) {
        this.handlers.onMessage(dec.decode(new Uint8Array(data)));
      } else if (data instanceof Blob && data.size < 8192) {
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
    if (!this.ws || this.ws.readyState !== 1) return false;
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
  return new MqttRelay(topicFor(roomId), handlers);
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
