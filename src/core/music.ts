// Original procedural music for replay videos. Every loop is synthesized in the
// browser from oscillators, envelopes and a generated reverb impulse — no audio
// files, samples, vocals or third-party recordings are bundled.
const A4 = 440;
const SEMITONES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const MUSIC_PREF_RANDOM = 'random';

export interface MusicTrack {
  id: string;
  labelKey: string;
  bpm: number;
  bars: number;
  chords: number[][];
  bass: number[];
  arp: number[];
  arpOctave: number[];
  arpGain: number;
  padGain: number;
  bellGain: number;
  bellBars: number[];
  brightness: number;
  seed: number;
}

export const MUSIC_TRACKS: MusicTrack[] = [
  {
    id: 'dawn',
    labelKey: 'music.dawn',
    bpm: 76, bars: 4,
    chords: [[62, 66, 69, 73], [59, 62, 66, 69], [55, 59, 62, 66], [57, 62, 64, 67]],
    bass: [50, 47, 43, 45],
    arp: [0, 2, 1, 3, 2, 1, 3, 2],
    arpOctave: [12, 0, 12, 0, 12, 0, 12, 0],
    arpGain: 0.05, padGain: 0.034, bellGain: 0.032, bellBars: [0, 2],
    brightness: 1800, seed: 17
  },
  {
    id: 'ridge',
    labelKey: 'music.ridge',
    bpm: 66, bars: 4,
    chords: [[57, 60, 64, 71], [53, 57, 60, 64], [48, 52, 55, 59], [55, 59, 62, 64]],
    bass: [45, 41, 36, 43],
    arp: [0, -1, 2, -1, 1, -1, 3, -1],
    arpOctave: [0, 0, 12, 0, 12, 0, 0, 0],
    arpGain: 0.06, padGain: 0.04, bellGain: 0.022, bellBars: [1, 3],
    brightness: 1300, seed: 41
  },
  {
    id: 'star',
    labelKey: 'music.star',
    bpm: 60, bars: 4,
    chords: [[64, 68, 71, 75], [61, 64, 68, 71], [57, 61, 64, 68], [59, 64, 66, 69]],
    bass: [52, 49, 45, 47],
    arp: [0, 1, 2, 3, 2, 1, 3, 0],
    arpOctave: [12, 12, 12, 12, 0, 0, 12, 12],
    arpGain: 0.038, padGain: 0.036, bellGain: 0.03, bellBars: [0, 1, 2, 3],
    brightness: 2600, seed: 73
  },
  {
    id: 'breeze',
    labelKey: 'music.breeze',
    bpm: 88, bars: 4,
    chords: [[55, 59, 62, 66], [52, 55, 59, 62], [48, 52, 55, 59], [50, 55, 57, 62]],
    bass: [43, 40, 36, 38],
    arp: [0, 2, 1, 3, 3, 1, 2, 0],
    arpOctave: [12, 0, 12, 0, 12, 0, 12, 0],
    arpGain: 0.045, padGain: 0.032, bellGain: 0.026, bellBars: [0, 3],
    brightness: 2200, seed: 97
  }
];

export interface MusicEvent {
  beat: number;
  dur: number;
  midi: number;
  gain: number;
  voice: 'pad' | 'pluck' | 'bass' | 'bell';
  pan: number;
}

export function midiToFreq(midi: number) {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(midi: number) {
  return `${SEMITONES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function isMusicTrackId(value: unknown) {
  return MUSIC_TRACKS.some((track) => track.id === value);
}

export function resolveMusicTrack(pref: unknown, random = Math.random): MusicTrack {
  const manual = MUSIC_TRACKS.find((track) => track.id === pref);
  if (manual) return manual;
  const r = Math.min(0.999999, Math.max(0, Number(random()) || 0));
  return MUSIC_TRACKS[Math.floor(r * MUSIC_TRACKS.length)];
}

export function musicLoopSeconds(track: MusicTrack) {
  return (track.bars * 4 * 60) / track.bpm;
}

export function composeLoop(track: MusicTrack): { events: MusicEvent[]; loopSeconds: number; beatsPerBar: number } {
  const beatsPerBar = 4;
  const events: MusicEvent[] = [];
  const padPan = [-0.22, 0.16, -0.08, 0.24];
  for (let bar = 0; bar < track.bars; bar++) {
    const start = bar * beatsPerBar;
    const chord = track.chords[bar % track.chords.length];
    chord.forEach((midi, i) => {
      events.push({
        beat: start, dur: 3.65, midi, gain: track.padGain,
        voice: 'pad', pan: padPan[i % padPan.length]
      });
    });

    const bass = track.bass[bar % track.bass.length];
    events.push({ beat: start, dur: 1.9, midi: bass, gain: 0.11, voice: 'bass', pan: 0 });
    events.push({ beat: start + 2.5, dur: 1.15, midi: bass, gain: 0.075, voice: 'bass', pan: 0 });

    track.arp.forEach((tone, step) => {
      if (tone < 0) return;
      const midi = chord[tone % chord.length] + track.arpOctave[step % track.arpOctave.length];
      const gain = track.arpGain * (step === 0 ? 1 : step % 2 ? 0.72 : 0.86);
      events.push({
        beat: start + step * 0.5, dur: 0.8, midi, gain,
        voice: 'pluck', pan: step % 2 ? 0.28 : -0.24
      });
    });

    if (track.bellBars.includes(bar)) {
      const top = chord[chord.length - 1] + 12;
      events.push({ beat: start + 0.5, dur: 2.2, midi: top, gain: track.bellGain, voice: 'bell', pan: 0.2 });
      events.push({ beat: start + 2.5, dur: 1.8, midi: top + 7, gain: track.bellGain * 0.75, voice: 'bell', pan: -0.18 });
    }
  }
  return { events, loopSeconds: musicLoopSeconds(track), beatsPerBar };
}

function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createImpulse(ctx: BaseAudioContext, seconds: number, seed: number) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  const rand = seededRandom(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const decay = Math.pow(1 - i / len, 2.35);
      data[i] = (rand() * 2 - 1) * decay * (ch ? 0.82 : 1);
    }
  }
  return buffer;
}

function offlineCtor(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext || null;
}

function realtimeCtor(): any {
  if (typeof window === 'undefined') return null;
  return (window as any).AudioContext || (window as any).webkitAudioContext || null;
}

function addPanner(ctx: BaseAudioContext, input: AudioNode, pan: number) {
  if (!(ctx as any).createStereoPanner) return input;
  const panner = (ctx as any).createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  input.connect(panner);
  return panner;
}

function schedulePad(ctx: BaseAudioContext, event: MusicEvent, secondsPerBeat: number, bus: AudioNode, reverb: AudioNode, cutoff: number) {
  const t = event.beat * secondsPerBeat;
  const dur = event.dur * secondsPerBeat;
  const attack = Math.min(1.1, dur * 0.42);
  const release = Math.min(1.5, dur * 0.5);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 0.4;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(event.gain, t + attack);
  gain.gain.setValueAtTime(event.gain, t + Math.max(attack, dur - 0.2));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
  filter.connect(gain);
  const out = addPanner(ctx, gain, event.pan);
  out.connect(bus);
  out.connect(reverb);

  for (const [type, detune, level] of [['sine', -4, 1], ['triangle', 4, 0.55]] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToFreq(event.midi);
    osc.detune.value = detune;
    const mix = ctx.createGain();
    mix.gain.value = level;
    osc.connect(mix);
    mix.connect(filter);
    osc.start(t);
    osc.stop(t + dur + release + 0.1);
  }
}

function schedulePluck(ctx: BaseAudioContext, event: MusicEvent, secondsPerBeat: number, bus: AudioNode, reverb: AudioNode, cutoff: number) {
  const t = event.beat * secondsPerBeat;
  const decay = Math.min(2.1, 0.9 + event.dur * secondsPerBeat * 0.45);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(event.gain, t + 0.014);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  filter.connect(gain);
  const out = addPanner(ctx, gain, event.pan);
  out.connect(bus);
  out.connect(reverb);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = midiToFreq(event.midi);
  osc.connect(filter);
  osc.start(t);
  osc.stop(t + decay + 0.05);

  const overtone = ctx.createOscillator();
  overtone.type = 'triangle';
  overtone.frequency.value = midiToFreq(event.midi + 12);
  const overtoneGain = ctx.createGain();
  overtoneGain.gain.value = 0.16;
  overtone.connect(overtoneGain);
  overtoneGain.connect(filter);
  overtone.start(t);
  overtone.stop(t + decay + 0.05);
}

function scheduleBell(ctx: BaseAudioContext, event: MusicEvent, secondsPerBeat: number, bus: AudioNode, reverb: AudioNode) {
  const t = event.beat * secondsPerBeat;
  const decay = Math.min(3.2, 1.4 + event.dur * secondsPerBeat * 0.35);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(event.gain, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  const out = addPanner(ctx, gain, event.pan);
  out.connect(bus);
  out.connect(reverb);
  for (const [ratio, level] of [[1, 1], [2.01, 0.18]] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midiToFreq(event.midi) * ratio;
    const mix = ctx.createGain();
    mix.gain.value = level;
    osc.connect(mix);
    mix.connect(gain);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

function scheduleBass(ctx: BaseAudioContext, event: MusicEvent, secondsPerBeat: number, master: AudioNode) {
  const t = event.beat * secondsPerBeat;
  const decay = Math.min(2.4, 1.1 + event.dur * secondsPerBeat);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 360;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(event.gain, t + 0.035);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  filter.connect(gain);
  gain.connect(master);
  for (const [type, detune, level] of [['sine', 0, 1], ['triangle', -7, 0.35]] as const) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToFreq(event.midi);
    osc.detune.value = detune;
    const mix = ctx.createGain();
    mix.gain.value = level;
    osc.connect(mix);
    mix.connect(filter);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}

/** Render one seamless loop (plus wrapped reverb tail) at the given sample rate. */
export async function renderMusicLoop(track: MusicTrack, sampleRate = 44100): Promise<AudioBuffer | null> {
  const Offline = offlineCtor();
  if (!Offline) return null;
  const sr = Math.max(22050, Math.min(96000, Math.round(sampleRate || 44100)));
  const loopSeconds = musicLoopSeconds(track);
  const loopSamples = Math.round(loopSeconds * sr);
  const tailSeconds = 1.7;
  const tailSamples = Math.round(tailSeconds * sr);
  const ctx = new Offline(2, loopSamples + tailSamples, sr);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 26;
  comp.ratio.value = 3;
  comp.attack.value = 0.006;
  comp.release.value = 0.25;
  comp.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.72;
  master.connect(comp);

  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulse(ctx, 1.8, track.seed);
  const wet = ctx.createGain();
  wet.gain.value = 0.34;
  convolver.connect(wet);
  wet.connect(master);
  const reverbIn = ctx.createGain();
  reverbIn.gain.value = 1;
  reverbIn.connect(convolver);

  const padBus = ctx.createGain();
  padBus.connect(master);
  const pluckBus = ctx.createGain();
  pluckBus.connect(master);
  const bellBus = ctx.createGain();
  bellBus.connect(master);

  const { events, beatsPerBar } = composeLoop(track);
  const secondsPerBeat = 60 / track.bpm;
  for (const event of events) {
    if (event.voice === 'pad') schedulePad(ctx, event, secondsPerBeat, padBus, reverbIn, track.brightness);
    else if (event.voice === 'pluck') schedulePluck(ctx, event, secondsPerBeat, pluckBus, reverbIn, track.brightness * 2.1);
    else if (event.voice === 'bell') scheduleBell(ctx, event, secondsPerBeat, bellBus, reverbIn);
    else scheduleBass(ctx, event, secondsPerBeat, master);
  }
  const rendered = await ctx.startRendering();
  if (!rendered) return null;

  const loop = ctx.createBuffer(2, loopSamples, sr);
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch);
    const dst = loop.getChannelData(ch);
    dst.set(src.subarray(0, loopSamples));
    for (let i = 0; i < tailSamples; i++) dst[i] += src[loopSamples + i];
  }

  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const data = loop.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  const scale = peak > 0 ? 0.82 / peak : 0;
  const edge = Math.min(320, Math.floor(loopSamples / 4));
  for (let ch = 0; ch < 2; ch++) {
    const data = loop.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      let gain = scale;
      if (i < edge) gain *= i / edge;
      const fromEnd = data.length - 1 - i;
      if (fromEnd < edge) gain *= fromEnd / edge;
      data[i] *= gain;
    }
  }
  return loop;
}

export interface MusicSession {
  track: MusicTrack;
  attach(totalMs: number): Promise<MediaStreamTrack | null>;
  stop(): void;
}

/** Create the audio context inside the user gesture, then prepare the loop. */
export function createMusicSession(pref: unknown): MusicSession | null {
  const AC = realtimeCtor();
  if (!AC) return null;
  let context: AudioContext;
  try { context = new AC(); } catch { return null; }
  const track = resolveMusicTrack(pref);
  const prepared = renderMusicLoop(track, context.sampleRate).catch((e) => {
    console.warn('music render failed', e);
    return null;
  });
  try { context.resume().catch(() => { /* fallback to silent video */ }); } catch { /* ignore */ }

  let source: AudioBufferSourceNode | null = null;
  let output: GainNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let attached = false;
  let stopped = false;

  return {
    track,
    async attach(totalMs: number) {
      if (attached) return destination?.stream.getAudioTracks()[0] || null;
      attached = true;
      const buffer = await prepared;
      if (!buffer || context.state === 'closed') return null;
      if (context.state === 'suspended') {
        try { await context.resume(); } catch { /* silent fallback */ }
      }
      destination = context.createMediaStreamDestination();
      output = context.createGain();
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(output);
      output.connect(destination);
      const start = context.currentTime + 0.04;
      const totalSec = Math.max(1, totalMs / 1000);
      const fadeIn = Math.min(1.4, totalSec * 0.25);
      const fadeOut = Math.min(1.2, totalSec * 0.18);
      output.gain.setValueAtTime(0.0001, start);
      output.gain.exponentialRampToValueAtTime(0.9, start + fadeIn);
      const hold = Math.max(start + fadeIn + 0.05, start + totalSec - fadeOut);
      output.gain.setValueAtTime(0.9, hold);
      output.gain.exponentialRampToValueAtTime(0.0001, start + totalSec);
      source.start(start);
      return destination.stream.getAudioTracks()[0] || null;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        const now = context.currentTime;
        output?.gain.cancelScheduledValues(now);
        output?.gain.setTargetAtTime(0.0001, now, 0.04);
        source?.stop(now + 0.18);
      } catch { /* ignore */ }
      setTimeout(() => { context.close().catch(() => {}); }, 260);
    }
  };
}

export function musicSupported() {
  return !!realtimeCtor() && !!offlineCtor();
}
