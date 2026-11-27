// Shared compute workers with main-thread fallback and per-task cancellation.
// A task with an AbortSignal gets a dedicated worker. Timeout/cancel only
// settles that task; other tasks keep their workers and can finish normally.
import { computeStats } from './stats';
import { computeDistanceSplits } from './distanceSplits';
import { simplify } from './geo';
import { wgs84ToGcj02, gcj02ToWgs84 } from './coords';
import { previewTrackCleanup } from './gpsQuality';
import { buildTrackRepairPreview } from './trackRepair';
import { buildGPX, buildGeoJSON, buildKML } from './gpxFormat';
import { buildHeatmap } from './heatmap';
import { compareTracks } from './trackComparison';
import { buildAnnualReport } from './annualReport';
import { buildProfile } from './profileChart';
import { buildBackupArchive } from './backupArchive';
import { streamGPX } from './gpxStream';
import { prepareWorkerPayload } from './workerPayload';

const IDLE_RELEASE_MS = 30_000;
const MAX_SHARED_WORKERS = 2;

interface WorkerHost {
  instance: Worker;
  session: string;
  tasks: Set<number>;
  poisoned: boolean;
  isolated: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface WorkerTask {
  id: number;
  host: WorkerHost;
  type: string;
  payload: any;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  cancel: (() => void) | null;
}

let seq = 0;
let sessionSeq = 0;
const pending = new Map<number, WorkerTask>();
const sharedHosts = new Set<WorkerHost>();

function abortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

function settle(task: WorkerTask) {
  if (task.timer != null) clearTimeout(task.timer);
  task.timer = null;
  task.signal?.removeEventListener('abort', task.cancel!);
}

function taskError(data: any) {
  const error: any = new Error(data?.error || 'worker task failed');
  if (data?.name) error.name = data.name;
  if (data?.code) error.code = data.code;
  if (data?.stack) error.stack = data.stack;
  return error;
}

function fallback(type, payload) {
  switch (type) {
    case 'stats': return computeStats(payload.segments, payload.opts);
    case 'splits': return computeDistanceSplits(payload.segments, payload.intervalM, payload.opts);
    case 'simplify': return simplify(payload.points, payload.tolerance);
    case 'transform': {
      const fn = payload.dir === 'toGcj' ? wgs84ToGcj02 : gcj02ToWgs84;
      return payload.points.map((p) => { const [lon, lat] = fn(p.lon, p.lat); return { ...p, lon, lat }; });
    }
    case 'cleanup-preview': return previewTrackCleanup(payload.segments, payload.activity, payload.opts);
    case 'repair-preview': return buildTrackRepairPreview(payload.segments, payload.activity, payload.opts);
    case 'gpx': return buildGPX(payload.full);
    case 'geojson': return buildGeoJSON(payload.full, payload.opts);
    case 'kml': return buildKML(payload.full);
    case 'heatmap': return buildHeatmap(payload.trips, payload.opts);
    case 'track-comparison': return compareTracks(payload.a, payload.b, payload.opts);
    case 'annual-report': return buildAnnualReport(payload.entries, payload.year, payload.options);
    case 'profile': return buildProfile(payload.stats, payload.units, payload.maxPoints);
    case 'backup-archive': return buildBackupArchive(payload);
    default: throw new Error('unknown task');
  }
}

function resolveFallback(task: WorkerTask) {
  settle(task);
  try {
    task.resolve(fallback(task.type, task.payload));
  } catch (error) {
    task.reject(error);
  }
}

function createWorkerInstance() {
  try {
    return new Worker(new URL('../worker/compute.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function clearIdle(host: WorkerHost) {
  if (host.idleTimer != null) clearTimeout(host.idleTimer);
  host.idleTimer = null;
}

function stopHost(host: WorkerHost) {
  clearIdle(host);
  sharedHosts.delete(host);
  const instance = host.instance;
  instance.onmessage = null;
  instance.onerror = null;
  instance.onmessageerror = null;
  try { instance.terminate(); } catch { /* already stopped */ }
}

function scheduleIdle(host: WorkerHost) {
  if (host.isolated || host.poisoned || host.tasks.size || host.idleTimer != null) return;
  host.idleTimer = setTimeout(() => {
    host.idleTimer = null;
    if (!host.tasks.size) stopHost(host);
  }, IDLE_RELEASE_MS);
}

function hostFailed(host: WorkerHost) {
  const tasks = [...host.tasks]
    .map((id) => pending.get(id))
    .filter((task): task is WorkerTask => !!task);
  for (const task of tasks) {
    if (!pending.delete(task.id)) continue;
    host.tasks.delete(task.id);
    resolveFallback(task);
  }
  stopHost(host);
}

function bindHost(host: WorkerHost) {
  host.instance.onmessage = (event) => {
    const data = event.data || {};
    const task = pending.get(data.id);
    if (!task || task.host !== host) return;
    if (data.session != null && data.session !== host.session) return;
    pending.delete(task.id);
    host.tasks.delete(task.id);
    settle(task);
    if (host.isolated) stopHost(host);
    else if (host.poisoned && !host.tasks.size) stopHost(host);
    else scheduleIdle(host);
    if (data.ok) task.resolve(data.result);
    else task.reject(taskError(data));
  };
  host.instance.onerror = (event) => {
    event?.preventDefault?.();
    hostFailed(host);
  };
  host.instance.onmessageerror = () => hostFailed(host);
}

function createHost(isolated: boolean) {
  const instance = createWorkerInstance();
  if (!instance) return null;
  const host: WorkerHost = {
    instance,
    session: `w${++sessionSeq}`,
    tasks: new Set(),
    poisoned: false,
    isolated,
    idleTimer: null
  };
  bindHost(host);
  if (!isolated) sharedHosts.add(host);
  return host;
}

function acquireSharedHost() {
  let idle: WorkerHost | null = null;
  let leastBusy: WorkerHost | null = null;
  let active = 0;
  for (const host of sharedHosts) {
    if (host.poisoned) continue;
    active++;
    if (!host.tasks.size) { idle = host; break; }
    if (!leastBusy || host.tasks.size < leastBusy.tasks.size) leastBusy = host;
  }
  if (idle) return idle;
  if (active < MAX_SHARED_WORKERS) return createHost(false);
  return leastBusy;
}

function handlePostFailure(task: WorkerTask) {
  if (!pending.delete(task.id)) return;
  task.host.tasks.delete(task.id);
  clearIdle(task.host);
  if (task.host.isolated) stopHost(task.host);
  else if (task.host.poisoned && !task.host.tasks.size) stopHost(task.host);
  else scheduleIdle(task.host);
  resolveFallback(task);
}

function expireTask(task: WorkerTask) {
  if (!pending.delete(task.id)) return;
  task.host.tasks.delete(task.id);
  settle(task);
  if (task.host.isolated) stopHost(task.host);
  else {
    // The worker is stuck in this synchronous task. Keep it for other tasks
    // to finish, but never hand it new work; terminate once it is empty.
    task.host.poisoned = true;
    if (!task.host.tasks.size) stopHost(task.host);
  }
  resolveFallback(task);
}

function cancelTask(task: WorkerTask) {
  if (!pending.delete(task.id)) return;
  task.host.tasks.delete(task.id);
  settle(task);
  if (task.host.isolated) stopHost(task.host);
  else if (task.host.poisoned && !task.host.tasks.size) stopHost(task.host);
  else scheduleIdle(task.host);
  task.reject(abortError());
}

export function runTask(type, payload, { signal, timeoutMs = 15000 }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  if (signal?.aborted) return Promise.reject(abortError());
  const isolated = Boolean(signal);
  const host = isolated ? createHost(true) : acquireSharedHost();
  if (!host) return Promise.resolve().then(() => {
    if (signal?.aborted) throw abortError();
    return fallback(type, payload);
  });
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const task: WorkerTask = {
      id, host, type, payload, resolve, reject,
      timer: null, signal, cancel: null
    };
    const cancel = () => cancelTask(task);
    task.cancel = cancel;
    host.tasks.add(id);
    pending.set(id, task);
    clearIdle(host);
    signal?.addEventListener('abort', cancel, { once: true });
    if (timeoutMs > 0) task.timer = setTimeout(() => expireTask(task), timeoutMs);
    try {
      const { transferList, ...wire } = prepareWorkerPayload(type, payload);
      const message = { id, session: host.session, type, ...wire };
      if (transferList.length) host.instance.postMessage(message, transferList);
      else host.instance.postMessage(message);
    } catch {
      handlePostFailure(task);
    }
  });
}

function trackTaskTimeout(segments) {
  const pointCount = segments.reduce((sum, segment) => sum + segment.points.length, 0);
  return pointCount > 100_000 ? 180_000 : 15_000;
}

export const computeStatsAsync = (segments, opts) => runTask('stats', { segments, opts }, { timeoutMs: trackTaskTimeout(segments) });
export const computeStatsSummaryAsync = (segments, opts = {}) => computeStatsAsync(segments, { ...opts, series: false });
export const computeDistanceSplitsAsync = (segments, intervalM = 1000, opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('splits', { segments, intervalM, opts }, { timeoutMs: trackTaskTimeout(segments), ...options });
export const simplifyAsync = (points, tolerance, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('simplify', { points, tolerance }, { timeoutMs: points.length > 100_000 ? 120_000 : 15_000, ...options });
export const transformAsync = (points, dir) => runTask('transform', { points, dir });
export const previewTrackCleanupAsync = (segments, activity = 'hike', opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('cleanup-preview', { segments, activity, opts }, { timeoutMs: trackTaskTimeout(segments), ...options });
export const previewTrackRepairAsync = (segments, activity = 'hike', opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('repair-preview', { segments, activity, opts }, { timeoutMs: trackTaskTimeout(segments), ...options });
export const buildGPXAsync = (full, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('gpx', { full }, { timeoutMs: 180_000, ...options });
export const buildGeoJSONAsync = (full, opts: { simplified?: any } = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('geojson', { full, opts }, { timeoutMs: 180_000, ...options });
export const buildKMLAsync = (full, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('kml', { full }, { timeoutMs: 180_000, ...options });
export const buildHeatmapAsync = (trips, opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('heatmap', { trips, opts }, { timeoutMs: 60_000, ...options });
export const compareTracksAsync = (a, b, opts: { sampleSpacingM?: number; maxSamples?: number; signal?: AbortSignal } = {}, options: { signal?: AbortSignal } = {}) => {
  const { signal: optionSignal, ...comparisonOpts } = opts;
  const signal = options.signal || optionSignal;
  return runTask('track-comparison', { a, b, opts: comparisonOpts }, { timeoutMs: 120_000, ...options, signal });
};
export const buildAnnualReportAsync = (entries, year, opts = {}, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('annual-report', { entries, year, options: opts }, { timeoutMs: 60_000, ...options });
export const buildProfileAsync = (stats, units = 'metric', maxPoints = 1800, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('profile', { stats, units, maxPoints }, { timeoutMs: 60_000, ...options });
export const buildBackupArchiveAsync = (input, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('backup-archive', input, { timeoutMs: 300_000, ...options });

export function streamGPXInWorker(
  input: Blob,
  onEvent: (event: any) => void | Promise<void>,
  options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; singlePass?: boolean } = {}
): Promise<{ name: string; hasTime: boolean; startTime: number | null; segments: number; waypoints: number; loaded: number }> {
  const { signal, onProgress, singlePass = true } = options;
  if (signal?.aborted) return Promise.reject(abortError());
  const instance = typeof Worker === 'undefined' ? null : createWorkerInstance();
  if (!instance) return streamGPX(input, onEvent, options);
  const id = ++seq;
  const session = `g${++sessionSeq}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      instance.onmessage = null;
      instance.onerror = null;
      instance.onmessageerror = null;
      try { instance.terminate(); } catch { /* already stopped */ }
    };
    const finish = (error: any, result?: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    instance.onmessage = async (event) => {
      const data = event.data || {};
      if (data.id !== id || data.session !== session) return;
      if (data.type === 'gpx-event') {
        try {
          await onEvent(data.event);
          if (settled) return;
          instance.postMessage({ id, session, ack: data.seq });
        } catch (error) {
          finish(error);
        }
        return;
      }
      if (data.type === 'gpx-progress') {
        onProgress?.(data.loaded, data.total);
        return;
      }
      if (data.ok) finish(null, data.result);
      else finish(taskError(data));
    };
    instance.onerror = (event) => {
      event?.preventDefault?.();
      finish(new Error('worker task failed'));
    };
    instance.onmessageerror = () => finish(new Error('worker task failed'));
    try {
      instance.postMessage({ id, session, type: 'stream-gpx', payload: { file: input, singlePass } });
    } catch {
      instance.onmessage = null;
      instance.onerror = null;
      instance.onmessageerror = null;
      try { instance.terminate(); } catch { /* already stopped */ }
      streamGPX(input, onEvent, options).then(
        (result) => finish(null, result),
        (error) => finish(error)
      );
    }
  });
}
