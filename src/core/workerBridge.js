// Worker bridge with main-thread fallback (older browsers / worker load failure).
import { computeStats } from './stats.js';
import { simplify } from './geo.js';
import { wgs84ToGcj02, gcj02ToWgs84 } from './coords.js';

let worker = null;
let seq = 0;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('../worker/compute.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      ok ? p.resolve(result) : p.reject(new Error(error));
    };
    worker.onerror = () => {
      for (const [, p] of pending) p.reject(new Error('worker crashed'));
      pending.clear();
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
}

function fallback(type, payload) {
  switch (type) {
    case 'stats': return computeStats(payload.segments, payload.opts);
    case 'simplify': return simplify(payload.points, payload.tolerance);
    case 'transform': {
      const fn = payload.dir === 'toGcj' ? wgs84ToGcj02 : gcj02ToWgs84;
      return payload.points.map((p) => { const [lon, lat] = fn(p.lon, p.lat); return { ...p, lon, lat }; });
    }
    default: throw new Error('unknown task');
  }
}

export function runTask(type, payload) {
  const w = ensureWorker();
  if (!w) return Promise.resolve(fallback(type, payload));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    w.postMessage({ id, type, payload });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        try { resolve(fallback(type, payload)); } catch (e) { reject(e); }
      }
    }, 15000);
  });
}

export const computeStatsAsync = (segments, opts) => runTask('stats', { segments, opts });
export const simplifyAsync = (points, tolerance) => runTask('simplify', { points, tolerance });
export const transformAsync = (points, dir) => runTask('transform', { points, dir });