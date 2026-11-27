import { haversine } from './geo';
import { applyPrivacy } from './privacy';

export interface HeatmapOptions {
  maxPoints?: number;
  gridSize?: number;
  privacyRadius?: number;
}

export interface HeatmapResult {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { weight: number; trips: number; tripIds: string[] };
  }>;
  bbox: [number, number, number, number] | null;
  stats: {
    tripCount: number;
    sourcePoints: number;
    sampledPoints: number;
    croppedPoints: number;
    gridCells: number;
    maxWeight: number;
  };
}

interface DistancePoint {
  lat: number;
  lon: number;
  segmentId: string;
  distance: number;
}

interface HeatmapCell {
  lat: number;
  lon: number;
  weight: number;
  tripIds: Set<string>;
}

function wrapLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function validPoint(point: any) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

export function sampleSegmentsByDistance(segments: any[], limit: number) {
  const runs: DistancePoint[][] = [];
  let total = 0;
  for (const segment of segments || []) {
    const points = (segment.points || []).filter(validPoint);
    if (points.length < 2) continue;
    const run: DistancePoint[] = [];
    let previousLon = points[0].lon;
    let unwrappedLon = previousLon;
    for (let index = 0; index < points.length; index++) {
      if (index) {
        total += haversine(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
        unwrappedLon += wrapLongitude(points[index].lon - previousLon);
      }
      run.push({ lat: points[index].lat, lon: wrapLongitude(unwrappedLon), segmentId: String(segment.id || ''), distance: total });
      previousLon = points[index].lon;
    }
    runs.push(run);
  }
  if (!runs.length || !(total > 0)) return [];
  const count = Math.max(2, Math.min(Math.floor(limit) || 2, 20_000));
  const output: DistancePoint[] = [];
  let runIndex = 0;
  let pointIndex = 0;
  for (let sample = 0; sample < count; sample++) {
    if (sample === 0) { output.push(runs[0][0]); continue; }
    if (sample === count - 1) { output.push(runs[runs.length - 1].at(-1)!); break; }
    const target = total * sample / (count - 1);
    while (runIndex < runs.length - 1 && runs[runIndex].at(-1)!.distance < target) {
      runIndex++;
      pointIndex = 0;
    }
    const run = runs[runIndex];
    while (pointIndex < run.length - 1 && run[pointIndex].distance < target) pointIndex++;
    const next = run[pointIndex];
    if (pointIndex === 0 || next.distance === target) {
      output.push(next);
      continue;
    }
    const previous = run[pointIndex - 1];
    const span = next.distance - previous.distance;
    const fraction = span > 0 ? (target - previous.distance) / span : 0;
    output.push({
      lat: previous.lat + (next.lat - previous.lat) * fraction,
      lon: wrapLongitude(previous.lon + wrapLongitude(next.lon - previous.lon) * fraction),
      segmentId: previous.segmentId,
      distance: target
    });
  }
  return output;
}

function emptyStats(): HeatmapResult['stats'] {
  return { tripCount: 0, sourcePoints: 0, sampledPoints: 0, croppedPoints: 0, gridCells: 0, maxWeight: 0 };
}

function addPoint(cells: Map<string, HeatmapCell>, lat: number, lon: number, tripId: string) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cell = cells.get(key) || { lat, lon, weight: 0, tripIds: new Set<string>() };
  cell.weight++;
  if (tripId) cell.tripIds.add(tripId);
  cells.set(key, cell);
}

function finishHeatmap(cells: Map<string, HeatmapCell>, stats: HeatmapResult['stats']): HeatmapResult {
  const features = [...cells.values()].map((cell) => ({
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [Number(cell.lon.toFixed(5)), Number(cell.lat.toFixed(5))] as [number, number] },
    properties: { weight: cell.weight, trips: cell.tripIds.size, tripIds: [...cell.tripIds] }
  }));
  stats.gridCells = features.length;
  stats.maxWeight = 0;
  if (!features.length) return { type: 'FeatureCollection', features: [], bbox: null, stats };

  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  let firstLon = features[0].geometry.coordinates[0];
  let previousLon = firstLon;
  let unwrappedLon = firstLon;
  let minUnwrappedLon = firstLon, maxUnwrappedLon = firstLon;
  for (const feature of features) {
    const [lon, lat] = feature.geometry.coordinates;
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    unwrappedLon += wrapLongitude(lon - previousLon);
    minUnwrappedLon = Math.min(minUnwrappedLon, unwrappedLon);
    maxUnwrappedLon = Math.max(maxUnwrappedLon, unwrappedLon);
    previousLon = lon;
    stats.maxWeight = Math.max(stats.maxWeight, feature.properties.weight);
  }
  const bbox: [number, number, number, number] = maxUnwrappedLon - minUnwrappedLon <= 180 && maxLon - minLon > 180
    ? [wrapLongitude(minUnwrappedLon), minLat, wrapLongitude(maxUnwrappedLon), maxLat]
    : [minLon, minLat, maxLon, maxLat];
  return { type: 'FeatureCollection', features, bbox, stats };
}

export function buildHeatmap(trips: Array<{ trip: any; segments: any[] }> = [], options: HeatmapOptions = {}): HeatmapResult {
  const maxPoints = Math.max(2, Math.min(20_000, Math.floor(options.maxPoints) || 4000));
  const gridSize = Math.max(0.0001, Math.min(0.02, options.gridSize || 0.001));
  const cells = new Map<string, HeatmapCell>();
  const stats = emptyStats();
  for (const full of trips) {
    if (!full?.trip || !Array.isArray(full.segments)) continue;
    const privacy = {
      ...(full.trip.privacy || {}),
      ...(options.privacyRadius != null ? { radius: options.privacyRadius } : {})
    };
    const cropped = applyPrivacy({ ...full, waypoints: [] }, privacy);
    const samples = sampleSegmentsByDistance(cropped.segments, maxPoints);
    if (!samples.length) continue;
    const firstPoint = full.segments.find((segment) => segment.points?.length)?.points?.[0];
    const lastPoint = [...full.segments].reverse().find((segment) => segment.points?.length)?.points?.at(-1);
    const radius = Number(privacy.radius);
    const circles = [privacy.start || firstPoint, privacy.end || lastPoint].filter((point) => point
      && Number.isFinite(point.lat) && Number.isFinite(point.lon));
    stats.tripCount++;
    stats.sourcePoints += full.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0);
    stats.sampledPoints += samples.length;
    stats.croppedPoints += cropped.croppedPoints || 0;
    const tripId = String(full.trip.id || '');
    for (const point of samples) {
      const lat = (Math.floor(point.lat / gridSize) + 0.5) * gridSize;
      const lon = (Math.floor(point.lon / gridSize) + 0.5) * gridSize;
      if (radius > 0 && circles.some((circle) => haversine(lat, lon, circle.lat, circle.lon) <= radius)) continue;
      addPoint(cells, lat, wrapLongitude(lon), tripId);
    }
  }
  return finishHeatmap(cells, stats);
}

export function createHeatmapAccumulator() {
  const cells = new Map<string, HeatmapCell>();
  const stats = emptyStats();
  return {
    add(result: HeatmapResult) {
      stats.tripCount += result.stats?.tripCount || 0;
      stats.sourcePoints += result.stats?.sourcePoints || 0;
      stats.sampledPoints += result.stats?.sampledPoints || 0;
      stats.croppedPoints += result.stats?.croppedPoints || 0;
      for (const feature of result.features || []) {
        const [lon, lat] = feature.geometry.coordinates;
        const tripIds = [...new Set(feature.properties.tripIds || [])];
        addPoint(cells, lat, lon, tripIds[0] || '');
        const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
        const cell = cells.get(key)!;
        for (const tripId of tripIds) cell.tripIds.add(tripId);
        cell.weight += Math.max(0, feature.properties.weight - 1);
      }
    },
    result(): HeatmapResult {
      return finishHeatmap(cells, stats);
    }
  };
}

export interface HeatmapBatchProgress {
  completed: number;
  total: number;
  result: HeatmapResult;
  succeededIds: string[];
  failedIds: string[];
}

/**
 * Compute tracks independently so one missing/corrupt track or worker failure
 * cannot discard heatmap cells produced by the rest of the batch.
 */
export async function buildHeatmapBatchAsync<T extends { id: string }>(
  tasks: T[],
  compute: (task: T, signal?: AbortSignal) => Promise<HeatmapResult | null>,
  options: {
    signal?: AbortSignal;
    initial?: HeatmapResult | null;
    onProgress?: (progress: HeatmapBatchProgress) => void;
  } = {}
) {
  const throwIfAborted = () => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  const accumulator = createHeatmapAccumulator();
  if (options.initial) accumulator.add(options.initial);
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  for (let index = 0; index < tasks.length; index++) {
    throwIfAborted();
    const task = tasks[index];
    try {
      const result = await compute(task, options.signal);
      throwIfAborted();
      if (!result) throw new Error('heatmap-track-unavailable');
      accumulator.add(result);
      succeededIds.push(task.id);
    } catch (error) {
      // Only cancellation of the whole batch escapes. A worker timeout may use
      // AbortError too, and must remain isolated to this track.
      if (options.signal?.aborted) throw error;
      failedIds.push(task.id);
    }
    options.onProgress?.({
      completed: index + 1,
      total: tasks.length,
      result: accumulator.result(),
      succeededIds: [...succeededIds],
      failedIds: [...failedIds]
    });
  }
  return { result: accumulator.result(), succeededIds, failedIds };
}

export function mergeHeatmaps(results: HeatmapResult[]): HeatmapResult {
  const accumulator = createHeatmapAccumulator();
  for (const result of results) accumulator.add(result);
  return accumulator.result();
}
