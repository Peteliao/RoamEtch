// Debug GPX playback simulator [v1.4]: feeds synthetic fixes through the real
// recorder pipeline (filters, segmentation, persistence all exercised).
import { parseGPX } from './gpx';
import { startRecording, stopRecording, handleFix, rec } from './recorder';
import { haversine, bearing } from './geo';
import { get } from './settings';
import { emit } from './events';
import { t } from './i18n';
import { buildDemoPoints } from './demo';
import { normalizeSimulationOptions, simulateTrack, type SimulationOptions } from './simulation';

let timer = null;
let playing = false;

export { buildDemoPoints as builtinDemoGPX };

export function isPlaying() { return playing; }

export async function startPlayback({ gpxText = null, name = null } = {}) {
  if (playing) return false;
  let points;
  if (gpxText) {
    const parsed = parseGPX(gpxText);
    points = parsed.segments.flat();
    if (!points.length) throw new Error('empty gpx');
    if (!points.some((p) => p.t)) {
      const t0 = Date.now();
      points.forEach((p, i) => { p.t = t0 + i * 10000; });
    }
  } else {
    points = buildDemoPoints();
  }
  const ok = await startRecording({ simulated: true, name: name || `${t('record.simRecording')} ${new Date().toLocaleTimeString()}` });
  if (!ok) return false;
  playing = true;
  emit('sim:started', { count: points.length });
  const speed = Math.max(1, get('sim').playbackSpeed || 20);
  const baseT = points[0].t;
  const wall0 = Date.now();
  let i = 0;
  const feedNext = () => {
    if (!playing || i >= points.length) {
      if (playing) finishPlayback();
      return;
    }
    const p = points[i];
    const prev = points[i - 1];
    let spd = null, hdg = null;
    if (prev) {
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      const dt = (p.t - prev.t) / 1000;
      if (dt > 0) spd = d / dt;
      hdg = bearing(prev.lat, prev.lon, p.lat, p.lon);
    }
    handleFix({
      lat: p.lat, lon: p.lon, acc: 6 + Math.random() * 6,
      alt: p.alt ?? null, altAcc: p.alt != null ? 8 : null,
      speed: spd, heading: hdg, t: wall0 + (p.t - baseT)
    });
    emit('sim:progress', { i: i + 1, total: points.length });
    i++;
    const nextDelay = i < points.length
      ? Math.max(16, (points[i].t - p.t) / speed)
      : 500;
    timer = setTimeout(feedNext, nextDelay);
  };
  timer = setTimeout(feedNext, 300);
  return true;
}

export async function finishPlayback() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!playing) return;
  playing = false;
  await stopRecording();
  emit('sim:stopped');
}

export function stopPlayback() { return finishPlayback(); }

export interface ScenarioPlaybackOptions extends SimulationOptions {
  name?: string;
  activity?: string;
  playbackSpeed?: number;
}

export async function startScenario(options: ScenarioPlaybackOptions = {}) {
  if (playing) return false;
  const config = normalizeSimulationOptions(options);
  const iterator = simulateTrack(config)[Symbol.iterator]();
  const activity = options.activity || (config.scenario === 'cycle' ? 'bike' : config.scenario === 'drive' ? 'drive' : 'hike');
  const ok = await startRecording({
    simulated: true,
    name: options.name || `${t('record.simRecording')} · ${config.scenario}`,
    activity
  });
  if (!ok) return false;
  playing = true;
  emit('sim:started', { scenario: config.scenario });
  const speed = Math.max(1, options.playbackSpeed || get('sim').playbackSpeed || 20);
  const wall0 = Date.now();
  let lastT = config.startTime;
  let count = 0;
  const feedNext = () => {
    if (!playing) return;
    let step;
    try {
      step = iterator.next();
    } catch (error) {
      console.error('scenario playback failed', error);
      void finishPlayback();
      return;
    }
    if (step.done) {
      void finishPlayback();
      return;
    }
    if (step.value.kind === 'event') {
      emit('sim:event', step.value.event);
      timer = setTimeout(feedNext, 0);
      return;
    }
    const fix = step.value.fix;
    const delay = Math.max(16, (fix.t - lastT) / speed);
    lastT = fix.t;
    void handleFix({ ...fix, t: wall0 + (fix.t - config.startTime) }).catch((error) => {
      console.error('scenario fix failed', error);
    });
    count++;
    emit('sim:progress', { i: count, scenario: config.scenario });
    timer = setTimeout(feedNext, delay);
  };
  timer = setTimeout(feedNext, 300);
  return true;
}
