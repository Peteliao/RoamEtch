// Worker bridge with main-thread fallback (older browsers / worker load failure).
import { computeStats } from './stats';
import { computeDistanceSplits } from './distanceSplits';
import { simplify } from './geo';
import { wgs84ToGcj02, gcj02ToWgs84 } from './coords';
import { previewTrackCleanup } from './gpsQuality';
import { buildTrackRepairPreview } from './trackRepair';
import { buildGPX } from './gpx';

let worker = null;
let seq = 0;
const pending = new Map();

function settle(task) {
  if (task.timer != null) clearTimeout(task.timer);
  task.timer = null;
  task.signal?.removeEventListener('abort', task.cancel);
}

function resolveFallback(task) {
  settle(task);
  try {
    task.resolve(fallback(task.type, task.payload));
  } catch (error) {
    task.reject(error);
  }
}

function stopWorker(instance) {
  instance.onmessage = null;
  instance.onerror = null;
  instance.onmessageerror = null;
  try { instance.terminate(); } catch {}
}

function discardWorker(failed) {
  const shared = worker === failed;
  if (shared) worker = null;
  stopWorker(failed);
  const tasks = [...pending.values()].filter((task) => task.instance === failed);
  for (const task of tasks) {
    if (!pending.delete(task.id)) continue;
    resolveFallback(task);
  }
  return shared || tasks.length > 0;
}

function createWorker() {
  try {
    return new Worker(new URL('../worker/compute.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function bindWorker(instance) {
  instance.onmessage = (e) => {
    const { id, ok, result, error } = e.data || {};
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    settle(task);
    if (task.isolated) stopWorker(instance);
    ok ? task.resolve(result) : task.reject(new Error(error || 'worker task failed'));
  };
  instance.onerror = (event) => {
    event?.preventDefault?.();
    discardWorker(instance);
  };
  instance.onmessageerror = () => discardWorker(instance);
  return instance;
}

function ensureWorker() {
  if (worker) return worker;
  const instance = createWorker();
  if (!instance) return null;
  worker = instance;
  return bindWorker(instance);
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
    default: throw new Error('unknown task');
  }
}

export function runTask(type, payload, { signal, timeoutMs = 15000 }: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const isolated = Boolean(signal);
  let instance;
  if (isolated) {
    const dedicated = createWorker();
    instance = dedicated ? bindWorker(dedicated) : null;
  } else {
    instance = ensureWorker();
  }
  if (!instance) return Promise.resolve().then(() => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return fallback(type, payload);
  });
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const task = {
      id, instance, isolated,
      type, payload, resolve, reject, timer: null as ReturnType<typeof setTimeout> | null, signal, cancel: null
    };
    const cancel = () => {
      if (!pending.delete(id)) return;
      settle(task);
      reject(new DOMException('Aborted', 'AbortError'));
      // A synchronous worker cannot receive a cancel message until its current
      // computation finishes, so termination is the only reliable interruption.
      if (isolated) stopWorker(instance);
      else discardWorker(instance);
    };
    task.cancel = cancel;
    pending.set(id, task);
    signal?.addEventListener('abort', cancel, { once: true });
    if (timeoutMs > 0) task.timer = setTimeout(() => discardWorker(instance), timeoutMs);
    try {
      instance.postMessage({ id, type, payload });
    } catch {
      if (!discardWorker(instance) && pending.delete(id)) {
        settle(task);
        resolveFallback(task);
      }
    }
  });
}

function trackTaskTimeout(segments) {
  const pointCount = segments.reduce((sum, segment) => sum + segment.points.length, 0);
  return pointCount > 100_000 ? 180_000 : 15_000;
}

export const computeStatsAsync = (segments, opts) => runTask('stats', { segments, opts }, { timeoutMs: trackTaskTimeout(segments) });
export const computeStatsSummaryAsync = (segments, opts = {}) => computeStatsAsync(segments, { ...opts, series: false });
export const computeDistanceSplitsAsync = (segments, intervalM = 1000, opts = {}) =>
  runTask('splits', { segments, intervalM, opts }, { timeoutMs: trackTaskTimeout(segments) });
export const simplifyAsync = (points, tolerance) =>
  runTask('simplify', { points, tolerance }, { timeoutMs: points.length > 100_000 ? 120_000 : 15_000 });
export const transformAsync = (points, dir) => runTask('transform', { points, dir });
export const previewTrackCleanupAsync = (segments, activity = 'hike', opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('cleanup-preview', { segments, activity, opts }, { timeoutMs: trackTaskTimeout(segments), ...options });
export const previewTrackRepairAsync = (segments, activity = 'hike', opts = {}, options: { signal?: AbortSignal } = {}) =>
  runTask('repair-preview', { segments, activity, opts }, { timeoutMs: trackTaskTimeout(segments), ...options });
export const buildGPXAsync = (full, options: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
  runTask('gpx', { full }, { timeoutMs: 180_000, ...options });