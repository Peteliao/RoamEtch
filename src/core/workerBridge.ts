// Worker bridge with main-thread fallback (older browsers / worker load failure).
import { computeStats } from './stats';
import { computeDistanceSplits } from './distanceSplits';
import { simplify } from './geo';
import { wgs84ToGcj02, gcj02ToWgs84 } from './coords';

let worker = null;
let seq = 0;
const pending = new Map();

function settle(task) {
  if (task.timer != null) clearTimeout(task.timer);
  task.timer = null;
}

function resolveFallback(task) {
  settle(task);
  try {
    task.resolve(fallback(task.type, task.payload));
  } catch (error) {
    task.reject(error);
  }
}

function discardWorker(failed) {
  if (worker !== failed) return false;
  worker = null;
  failed.onmessage = null;
  failed.onerror = null;
  failed.onmessageerror = null;
  try { failed.terminate(); } catch {}
  const tasks = [...pending.values()];
  pending.clear();
  for (const task of tasks) resolveFallback(task);
  return true;
}

function ensureWorker() {
  if (worker) return worker;
  try {
    const instance = new Worker(new URL('../worker/compute.worker.ts', import.meta.url), { type: 'module' });
    worker = instance;
    instance.onmessage = (e) => {
      const { id, ok, result, error } = e.data || {};
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      settle(task);
      ok ? task.resolve(result) : task.reject(new Error(error || 'worker task failed'));
    };
    instance.onerror = (event) => {
      event?.preventDefault?.();
      discardWorker(instance);
    };
    instance.onmessageerror = () => discardWorker(instance);
  } catch {
    worker = null;
  }
  return worker;
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
    default: throw new Error('unknown task');
  }
}

export function runTask(type, payload) {
  const instance = ensureWorker();
  if (!instance) return Promise.resolve().then(() => fallback(type, payload));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const task = {
      type, payload, resolve, reject, timer: null as ReturnType<typeof setTimeout> | null
    };
    pending.set(id, task);
    task.timer = setTimeout(() => discardWorker(instance), 15000);
    try {
      instance.postMessage({ id, type, payload });
    } catch {
      if (!discardWorker(instance) && pending.delete(id)) resolveFallback(task);
    }
  });
}

export const computeStatsAsync = (segments, opts) => runTask('stats', { segments, opts });
export const computeDistanceSplitsAsync = (segments, intervalM = 1000, opts = {}) =>
  runTask('splits', { segments, intervalM, opts });
export const simplifyAsync = (points, tolerance) => runTask('simplify', { points, tolerance });
export const transformAsync = (points, dir) => runTask('transform', { points, dir });