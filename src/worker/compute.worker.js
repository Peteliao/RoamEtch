// Background compute: stats, simplification, batch coordinate transform.
import { computeStats } from '../core/stats.js';
import { simplify } from '../core/geo.js';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../core/coords.js';

self.onmessage = (e) => {
  const { id, type, payload } = e.data;
  try {
    let result;
    switch (type) {
      case 'stats':
        result = computeStats(payload.segments, payload.opts);
        break;
      case 'simplify':
        result = simplify(payload.points, payload.tolerance);
        break;
      case 'transform': {
        const fn = payload.dir === 'toGcj' ? wgs84ToGcj02 : gcj02ToWgs84;
        result = payload.points.map((p) => {
          const [lon, lat] = fn(p.lon, p.lat);
          return { ...p, lon, lat };
        });
        break;
      }
      default:
        throw new Error('unknown task ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};