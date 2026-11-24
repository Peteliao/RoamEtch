export const CHAT_VOICE_MAX_BYTES = 64 * 1024;
export const CHAT_VOICE_MAX_BASE64 = Math.ceil(CHAT_VOICE_MAX_BYTES * 4 / 3) + 16;
export const CHAT_VOICE_MAX_DURATION_MS = 15_000;
export const CHAT_VOICE_MIN_DURATION_MS = 500;
export const CHAT_VOICE_KEEP = 20;
export const CHAT_VOICE_MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'] as const;

export type ChatVoiceMime = typeof CHAT_VOICE_MIMES[number];
export type ChatVoicePayload = {
  base64: string;
  mime: ChatVoiceMime;
  duration: number;
  waveform: number[];
};
export type RecordedChatVoice = ChatVoicePayload & { blob: Blob };

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeChatVoiceBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function validVoiceHeader(bytes: Uint8Array, mime: ChatVoiceMime) {
  if (mime === 'audio/webm;codecs=opus') {
    return bytes.length >= 16 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  }
  if (mime === 'audio/ogg;codecs=opus') {
    return bytes.length >= 16 && String.fromCharCode(...bytes.subarray(0, 4)) === 'OggS';
  }
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
}

export function sanitizeChatVoicePacket(msg: any): ChatVoicePayload | null {
  const base64 = typeof msg?.au === 'string' ? msg.au.trim() : '';
  if (!base64 || base64.length > CHAT_VOICE_MAX_BASE64 || base64.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const mime = String(msg?.aut || '').toLowerCase() as ChatVoiceMime;
  if (!CHAT_VOICE_MIMES.includes(mime)) return null;
  const duration = Number(msg?.aud);
  if (!Number.isInteger(duration) || duration < CHAT_VOICE_MIN_DURATION_MS || duration > CHAT_VOICE_MAX_DURATION_MS) return null;
  const waveform = msg?.auw == null ? [] : msg.auw;
  if (!Array.isArray(waveform) || waveform.length > 32
    || waveform.some((value: any) => !Number.isInteger(value) || value < 0 || value > 31)) return null;
  try {
    const bytes = decodeBase64(base64);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const size = base64.length * 3 / 4 - padding;
    if (!size || size > CHAT_VOICE_MAX_BYTES || !validVoiceHeader(bytes, mime)) return null;
    return { base64, mime, duration, waveform: [...waveform] };
  } catch {
    return null;
  }
}

export function chatVoiceBlob(payload: Pick<ChatVoicePayload, 'base64' | 'mime'>) {
  try {
    const bytes = decodeBase64(payload.base64);
    if (!validVoiceHeader(bytes, payload.mime)) return null;
    return new Blob([bytes.slice().buffer], { type: payload.mime });
  } catch {
    return null;
  }
}

export async function encodeChatVoice(blob: Blob, mime: ChatVoiceMime, duration: number, waveform: number[]) {
  const base64 = encodeChatVoiceBase64(new Uint8Array(await blob.arrayBuffer()));
  return sanitizeChatVoicePacket({ au: base64, aut: mime, aud: duration, auw: waveform });
}

function resampleWaveform(samples: number[], count = 24) {
  if (samples.length <= count) return samples.slice(0, count);
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * samples.length / count);
    const end = Math.floor((i + 1) * samples.length / count);
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    result.push(Math.round(sum / Math.max(1, end - start)));
  }
  return result;
}

export class ChatVoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private sampleTimer: any = null;
  private chunks: Blob[] = [];
  private samples: number[] = [];
  private startedAt = 0;
  private mime: ChatVoiceMime | null = null;
  private stopped = false;
  private finalized = false;
  private error: Error | null = null;

  async start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('voice-unsupported');
    const mime = CHAT_VOICE_MIMES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mime) throw new Error('voice-unsupported');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    this.stream = stream;
    try {
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 24_000 });
      } catch {
        recorder = new MediaRecorder(stream, { mimeType: mime });
      }
      this.recorder = recorder;
      this.mime = mime;
      recorder.ondataavailable = (event) => { if (event.data.size) this.chunks.push(event.data); };
      recorder.onerror = () => { this.error = new Error('voice-record-failed'); };
      recorder.start(200);
      this.startedAt = Date.now();
      this.startAnalyser(stream);
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }

  private startAnalyser(stream: MediaStream) {
    const Context = window.AudioContext || (window as any).webkitAudioContext;
    if (!Context) return;
    try {
      this.context = new Context();
      this.source = this.context.createMediaStreamSource(stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this.source.connect(this.analyser);
      void this.context.resume().catch(() => undefined);
      const buffer = new Uint8Array(this.analyser.fftSize);
      this.sampleTimer = window.setInterval(() => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(buffer);
        let energy = 0;
        for (const value of buffer) {
          const sample = (value - 128) / 128;
          energy += sample * sample;
        }
        const rms = Math.sqrt(energy / buffer.length);
        this.samples.push(Math.min(31, Math.round(rms * 120)));
      }, 180);
    } catch {
      void this.context?.close().catch(() => undefined);
      this.context = null;
      this.source = null;
      this.analyser = null;
    }
  }

  stop(): Promise<RecordedChatVoice> {
    const recorder = this.recorder;
    const mime = this.mime;
    if (!recorder || !mime || this.stopped) return Promise.reject(new Error('voice-not-recording'));
    this.stopped = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (this.error) {
          this.cleanup();
          reject(this.error);
          return;
        }
        const blob = new Blob(this.chunks, { type: mime });
        const duration = Math.min(CHAT_VOICE_MAX_DURATION_MS, Math.max(0, Date.now() - this.startedAt));
        const waveform = resampleWaveform(this.samples);
        this.cleanup();
        if (duration < CHAT_VOICE_MIN_DURATION_MS) {
          reject(new Error('voice-too-short'));
          return;
        }
        encodeChatVoice(blob, mime, duration, waveform).then((payload) => {
          if (!payload) {
            reject(new Error(blob.size > CHAT_VOICE_MAX_BYTES ? 'voice-too-large' : 'voice-invalid'));
            return;
          }
          resolve({ ...payload, blob });
        }, reject);
      };
      recorder.onstop = finish;
      recorder.onerror = () => {
        if (settled) return;
        settled = true;
        this.cleanup();
        reject(new Error('voice-record-failed'));
      };
      if (recorder.state !== 'inactive') recorder.stop();
      else finish();
    });
  }

  cancel() {
    this.stopped = true;
    try { if (this.recorder?.state !== 'inactive') this.recorder?.stop(); } catch { /* already stopped */ }
    this.cleanup();
    this.chunks = [];
    this.finalized = true;
  }

  private cleanup() {
    if (this.finalized) return;
    this.finalized = true;
    clearInterval(this.sampleTimer);
    this.sampleTimer = null;
    try { this.source?.disconnect(); } catch { /* already disconnected */ }
    try { this.analyser?.disconnect(); } catch { /* already disconnected */ }
    this.source = null;
    this.analyser = null;
    if (this.context) void this.context.close().catch(() => undefined);
    this.context = null;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
  }
}
