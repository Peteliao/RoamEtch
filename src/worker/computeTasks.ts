// Pure worker task dispatch, separated from the WorkerGlobalScope shell.
import { computeStats } from '../core/stats';
import { computeDistanceSplits } from '../core/distanceSplits';
import { simplify } from '../core/geo';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../core/coords';
import { previewTrackCleanup } from '../core/gpsQuality';
import { buildTrackRepairPreview } from '../core/trackRepair';
import { buildGPX, buildGeoJSON, buildKML } from '../core/gpxFormat';
import { buildHeatmap } from '../core/heatmap';
import { compareTracks } from '../core/trackComparison';
import { buildAnnualReport } from '../core/annualReport';
import { buildProfile } from '../core/profileChart';
import { buildBackupArchive } from '../core/backupArchive';

// Results for synchronous tasks are returned directly so the worker can post
// without a microtask hop; only archive building yields a promise.
export function runComputeTask(type: string, payload: any): any {
  switch (type) {
    case 'stats':
      return computeStats(payload.segments, payload.opts);
    case 'splits':
      return computeDistanceSplits(payload.segments, payload.intervalM, payload.opts);
    case 'simplify':
      return simplify(payload.points, payload.tolerance);
    case 'transform': {
      const fn = payload.dir === 'toGcj' ? wgs84ToGcj02 : gcj02ToWgs84;
      return payload.points.map((point) => {
        const [lon, lat] = fn(point.lon, point.lat);
        return { ...point, lon, lat };
      });
    }
    case 'cleanup-preview':
      return previewTrackCleanup(payload.segments, payload.activity, payload.opts);
    case 'repair-preview':
      return buildTrackRepairPreview(payload.segments, payload.activity, payload.opts);
    case 'gpx':
      return buildGPX(payload.full);
    case 'geojson':
      return buildGeoJSON(payload.full, payload.opts);
    case 'kml':
      return buildKML(payload.full);
    case 'heatmap':
      return buildHeatmap(payload.trips, payload.opts);
    case 'track-comparison':
      return compareTracks(payload.a, payload.b, payload.opts);
    case 'annual-report':
      return buildAnnualReport(payload.entries, payload.year, payload.options);
    case 'profile':
      return buildProfile(payload.stats, payload.units, payload.maxPoints);
    case 'backup-archive':
      return buildBackupArchive(payload);
    default:
      throw new Error('unknown task ' + type);
  }
}
