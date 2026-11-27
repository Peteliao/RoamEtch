// Background compute: stats, distance splits, simplification, batch coordinate transform.
import { computeStats } from '../core/stats';
import { computeDistanceSplits } from '../core/distanceSplits';
import { simplify } from '../core/geo';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../core/coords';
import { previewTrackCleanup } from '../core/gpsQuality';
import { buildTrackRepairPreview } from '../core/trackRepair';
import { buildGPX } from '../core/gpx';
import { buildHeatmap } from '../core/heatmap';
import { compareTracks } from '../core/trackComparison';
import { decodeWorkerPayload } from '../core/workerPayload';

self.onmessage = (e) => {
  const { id, type } = e.data;
  const payload = decodeWorkerPayload(e.data.payload);
  try {
    let result;
    switch (type) {
      case 'stats':
        result = computeStats(payload.segments, payload.opts);
        break;
      case 'splits':
        result = computeDistanceSplits(payload.segments, payload.intervalM, payload.opts);
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
      case 'cleanup-preview':
        result = previewTrackCleanup(payload.segments, payload.activity, payload.opts);
        break;
      case 'repair-preview':
        result = buildTrackRepairPreview(payload.segments, payload.activity, payload.opts);
        break;
      case 'gpx':
        result = buildGPX(payload.full);
        break;
      case 'heatmap':
        result = buildHeatmap(payload.trips, payload.opts);
        break;
      case 'track-comparison':
        result = compareTracks(payload.a, payload.b, payload.opts);
        break;
      default:
        throw new Error('unknown task ' + type);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};