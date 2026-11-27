import { haversine } from './geo';
import { assessTrackGpsQuality } from './gpsQuality';
import { computeDistanceSplits, type DistanceSplit } from './distanceSplits';

export const DEFAULT_TRACK_COMPARISON_TOLERANCE_M = 30;
export const DEFAULT_TRACK_COMPARISON_SAMPLE_SPACING_M = 10;
export const DEFAULT_TRACK_COMPARISON_MAX_SAMPLES = 2_000;
export const MAX_TRACK_COMPARISON_SAMPLES = 20_000;
export const TRACK_COMPARISON_ALIGNMENT_SAMPLE_LIMIT = 200;
export const TRACK_COMPARISON_SPLIT_INTERVAL_M = 1000;
export const TRACK_COMPARISON_TIME_ALIGNMENT_SAMPLES = 41;

const EARTH_RADIUS_M = 6_371_008.8;
const GRID_LEAF_SIZE = 12;
const GRID_MAX_DEPTH = 12;
const DISTANCE_EPSILON_M = 1e-6;
const SLOPE_BANDS = [
  { key: 'descent-steep', minSlopePct: null, maxSlopePct: -10 },
  { key: 'descent-moderate', minSlopePct: -10, maxSlopePct: -5 },
  { key: 'descent-gentle', minSlopePct: -5, maxSlopePct: 0 },
  { key: 'flat', minSlopePct: 0, maxSlopePct: 5 },
  { key: 'climb-gentle', minSlopePct: 5, maxSlopePct: 10 },
  { key: 'climb-moderate', minSlopePct: 10, maxSlopePct: 15 },
  { key: 'climb-steep', minSlopePct: 15, maxSlopePct: null }
] as const;

export interface TrackComparisonPoint {
  lat: number;
  lon: number;
  alt?: number | null;
  t?: number | null;
  [key: string]: unknown;
}

export interface TrackComparisonSegment {
  id?: string | number | null;
  points: readonly TrackComparisonPoint[];
  [key: string]: unknown;
}

export interface TrackComparisonInput {
  id?: string | number | null;
  name?: string | null;
  activity?: string;
  segments: readonly TrackComparisonSegment[];
  stats?: unknown;
  sourcePointCount?: number;
  sourceGpsQuality?: ReturnType<typeof assessTrackGpsQuality>;
  /** Reuse already-computed fixed-distance splits instead of measuring them again. */
  splits?: readonly DistanceSplit[];
  splitIntervalM?: number;
}

export interface TrackComparisonOptions {
  sampleSpacingM?: number;
  maxSamples?: number;
  signal?: AbortSignal;
}

export interface TrackComparisonSideSummary {
  id: string | number | null;
  name: string | null;
  lengthM: number;
  pointCount: number;
  validPointCount: number;
  invalidPointCount: number;
  segmentCount: number;
  stats: unknown;
}

export interface TrackComparisonSummary {
  /** Distance-weighted over all source samples, including unmatched points; null when projection is unavailable. */
  meanErrorM: number | null;
  /** Distance-weighted 95th percentile; unmatched points remain in the distribution. Null when projection is unavailable. */
  p95ErrorM: number | null;
  /** Matched source distance / full source distance; stationary tracks use point ratio. */
  matchedRatio: number;
  matchedDistanceM: number;
  unmatchedDistanceM: number;
  /** Shorter full-track length divided by longer full-track length. */
  lengthRatio: number;
  toleranceM: number;
  sourceLengthM: number;
  targetLengthM: number;
  sampleCount: number;
  matchedSampleCount: number;
}

export interface TrackComparisonSamplePoint {
  lat: number;
  lon: number;
  alt?: number;
  t?: number;
}

export interface TrackSplitAnalysis {
  index: number;
  startDistanceM: number;
  endDistanceM: number;
  distanceM: number;
  durationMs: number;
  activeMs: number;
  movingMs: number;
  avgSpeedMps: number;
  maxSpeedMps: number;
  paceSecPerKm: number | null;
  ascentM: number;
  descentM: number;
  startAltM: number | null;
  endAltM: number | null;
  netElevationM: number | null;
  avgSlopePct: number | null;
  climbEfficiencyMph: number | null;
  elevationComplete: boolean;
  partial: boolean;
}

export interface TrackElevationPoint {
  distanceM: number;
  altM: number | null;
}

export interface TrackElevationAnalysis {
  complete: boolean;
  minAltM: number | null;
  maxAltM: number | null;
  points: TrackElevationPoint[];
}

export interface TrackSlopeBandAnalysis {
  key: string;
  minSlopePct: number | null;
  maxSlopePct: number | null;
  splitCount: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
  movingMs: number;
  climbEfficiencyMph: number | null;
}

export interface TrackProfessionalAnalysis {
  intervalM: number;
  durationMs: number;
  splits: TrackSplitAnalysis[];
  elevation: TrackElevationAnalysis;
  slopeBands: TrackSlopeBandAnalysis[];
}

export interface TrackTimePoint {
  elapsedMs: number;
  distanceM: number;
}

export interface TrackTimeAlignmentSample {
  progress: number;
  elapsedMs: number;
  a: TrackTimePoint | null;
  b: TrackTimePoint | null;
}

export interface TrackAlignmentSample {
  /** Cumulative horizontal distance along the source selected by `direction`. */
  distanceM: number;
  errorM: number;
  a: TrackComparisonSamplePoint;
  b: TrackComparisonSamplePoint;
}

export interface TrackComparisonLimitation {
  code:
    | 'sampled-geometry'
    | 'nearest-projection'
    | 'horizontal-only'
    | 'local-projection'
    | 'short-track'
    | 'stationary-track'
    | 'empty-track'
    | 'invalid-points'
    | 'segment-endpoint-floor';
  message: string;
}

export interface TrackComparisonError {
  side: 'a' | 'b';
  code: 'empty-track' | 'invalid-points';
  count: number;
  message: string;
}

export interface TrackComparisonResult {
  /** forward = a onto b; reverse = b onto a. Ties prefer forward. Null when no direction is measurable. */
  direction: 'forward' | 'reverse' | null;
  toleranceM: number;
  tracks: {
    a: TrackComparisonSideSummary;
    b: TrackComparisonSideSummary;
  };
  summaries: {
    forward: TrackComparisonSummary;
    reverse: TrackComparisonSummary;
  };
  samples: TrackAlignmentSample[];
  /** Global maximum-error projection from the selected direction, independent of the display cap. */
  worstSample: TrackAlignmentSample | null;
  /** Worker-resampled polylines suitable for local map display. */
  displayTracks: {
    a: TrackComparisonSegment[];
    b: TrackComparisonSegment[];
  };
  analysis: {
    a: TrackProfessionalAnalysis;
    b: TrackProfessionalAnalysis;
  };
  /** Elapsed-time alignment; a side is null after that track has finished. */
  timeAlignment: TrackTimeAlignmentSample[];
  gpsQuality: {
    a: ReturnType<typeof assessTrackGpsQuality>;
    b: ReturnType<typeof assessTrackGpsQuality>;
  };
  sampling: {
    sampleSpacingM: number;
    maxSamples: number;
    alignmentSampleLimit: number;
    aSampleCount: number;
    bSampleCount: number;
    aEffectiveSpacingM: number;
    bEffectiveSpacingM: number;
    limited: boolean;
  };
  limitations: TrackComparisonLimitation[];
  errors: TrackComparisonError[];
}

interface LocalPoint {
  lat: number;
  lon: number;
  x: number;
  y: number;
  alt?: number;
  t?: number;
}

interface SamplePoint extends LocalPoint {
  segmentIndex: number;
  segmentId: string | number | null;
  segmentDistanceM: number;
  distanceM: number;
  weightM: number;
}

interface GeometrySegment {
  index: number;
  id: string | number | null;
  points: LocalPoint[];
  cumulative: number[];
  lengthM: number;
  samples: SamplePoint[];
}

interface PreparedTrack {
  segments: GeometrySegment[];
  samples: SamplePoint[];
  lengthM: number;
  rawPointCount: number;
  validPointCount: number;
  invalidPointCount: number;
  effectiveSpacingM: number;
}

interface Edge {
  from: SamplePoint;
  to: SamplePoint;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface GridNode {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  depth: number;
  edges: Edge[];
  children: GridNode[] | null;
}

interface GridHeapItem {
  node: GridNode;
  distance: number;
}

interface Projection {
  point: TrackComparisonSamplePoint;
  errorM: number;
}

interface Evaluation {
  source: PreparedTrack;
  target: PreparedTrack;
  rows: Array<{
    sample: SamplePoint;
    projection: Projection | null;
    errorM: number | null;
    matched: boolean;
  }>;
  summary: TrackComparisonSummary;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== 'undefined') return new DOMException('Track comparison aborted.', 'AbortError');
  const error = new Error('Track comparison aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function validPoint(point: TrackComparisonPoint | null | undefined): point is TrackComparisonPoint {
  return !!point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
}

function wrapLongitude(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

function toLocal(lat: number, lon: number, origin: { lat: number; lon: number }): { x: number; y: number } {
  const lonScale = Math.max(1e-6, Math.cos((origin.lat * Math.PI) / 180));
  return {
    x: EARTH_RADIUS_M * ((wrapLongitude(lon - origin.lon) * Math.PI) / 180) * lonScale,
    y: EARTH_RADIUS_M * ((lat - origin.lat) * Math.PI) / 180
  };
}

function fromLocal(x: number, y: number, origin: { lat: number; lon: number }): { lat: number; lon: number } {
  const lonScale = Math.max(1e-6, Math.cos((origin.lat * Math.PI) / 180));
  return {
    lat: Math.max(-90, Math.min(90, origin.lat + (y / EARTH_RADIUS_M) * (180 / Math.PI))),
    lon: wrapLongitude(origin.lon + (x / (EARTH_RADIUS_M * lonScale)) * (180 / Math.PI))
  };
}

function findOrigin(a: TrackComparisonInput, b: TrackComparisonInput, signal?: AbortSignal): { lat: number; lon: number } {
  for (const track of [a, b]) {
    for (const segment of Array.isArray(track?.segments) ? track.segments : []) {
      for (const point of Array.isArray(segment?.points) ? segment.points : []) {
        throwIfAborted(signal);
        if (validPoint(point)) return { lat: point.lat, lon: point.lon };
      }
    }
  }
  return { lat: 0, lon: 0 };
}

function normalizeOptions(options: TrackComparisonOptions) {
  const requestedSpacing = Number.isFinite(options.sampleSpacingM) && options.sampleSpacingM! > 0
    ? options.sampleSpacingM!
    : DEFAULT_TRACK_COMPARISON_SAMPLE_SPACING_M;
  const requestedMaximum = Number.isFinite(options.maxSamples) && options.maxSamples! > 0
    ? Math.floor(options.maxSamples!)
    : DEFAULT_TRACK_COMPARISON_MAX_SAMPLES;
  return {
    sampleSpacingM: Math.max(0.1, requestedSpacing),
    maxSamples: Math.max(1, Math.min(MAX_TRACK_COMPARISON_SAMPLES, requestedMaximum))
  };
}

function allocateSampleCounts(segments: GeometrySegment[], spacingM: number, maxSamples: number): number[] {
  const minimum = segments.map((segment) => segment.lengthM > DISTANCE_EPSILON_M ? 2 : 1);
  const baseTotal = minimum.reduce((sum, count) => sum + count, 0);
  const desired = segments.map((segment) => segment.lengthM > DISTANCE_EPSILON_M
    ? Math.max(0, Math.ceil(segment.lengthM / spacingM - 1e-9) - 1)
    : 0);
  const desiredTotal = desired.reduce((sum, count) => sum + count, 0);
  const optionalBudget = Math.max(0, maxSamples - baseTotal);
  if (desiredTotal <= optionalBudget) return minimum.map((count, index) => count + desired[index]);

  const extras = segments.map(() => 0);
  if (desiredTotal > 0 && optionalBudget > 0) {
    let assigned = 0;
    const remainders = segments.map((segment, index) => {
      const exact = optionalBudget * desired[index] / desiredTotal;
      const whole = Math.floor(exact);
      extras[index] = whole;
      assigned += whole;
      return { index, remainder: exact - whole, desired: desired[index] };
    });
    remainders.sort((left, right) => right.remainder - left.remainder || left.index - right.index);
    for (let index = 0; index < remainders.length && assigned < optionalBudget; index++) {
      if (remainders[index].desired > 0) {
        extras[remainders[index].index]++;
        assigned++;
      }
    }
  }
  return minimum.map((count, index) => count + extras[index]);
}

function interpolateLocal(
  points: LocalPoint[],
  cumulative: number[],
  distanceM: number,
  origin: { lat: number; lon: number }
): LocalPoint {
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (cumulative[middle] < distanceM) low = middle;
    else high = middle - 1;
  }
  const index = Math.max(0, low);
  const from = points[index];
  const to = points[Math.min(index + 1, points.length - 1)];
  const span = cumulative[index + 1] - cumulative[index];
  const fraction = span > 0 ? Math.max(0, Math.min(1, (distanceM - cumulative[index]) / span)) : 0;
  const local = toLocal(from.lat, from.lon, origin);
  const next = toLocal(to.lat, to.lon, origin);
  if (fraction <= 1e-12) return { ...from };
  if (fraction >= 1 - 1e-12) return { ...to };
  const projected = fromLocal(local.x + (next.x - local.x) * fraction, local.y + (next.y - local.y) * fraction, origin);
  const point: LocalPoint = { lat: projected.lat, lon: projected.lon, x: local.x + (next.x - local.x) * fraction, y: local.y + (next.y - local.y) * fraction };
  if (Number.isFinite(from.alt) && Number.isFinite(to.alt)) point.alt = from.alt! + (to.alt! - from.alt!) * fraction;
  if (Number.isFinite(from.t) && Number.isFinite(to.t)) point.t = from.t! + (to.t! - from.t!) * fraction;
  return point;
}

function prepareTrack(
  track: TrackComparisonInput,
  origin: { lat: number; lon: number },
  spacingM: number,
  maxSamples: number,
  signal?: AbortSignal
): PreparedTrack {
  const segments: GeometrySegment[] = [];
  let rawPointCount = 0;
  let validPointCount = 0;
  let invalidPointCount = 0;
  let lengthM = 0;

  for (const [segmentIndex, segment] of (Array.isArray(track?.segments) ? track.segments : []).entries()) {
    throwIfAborted(signal);
    const points: LocalPoint[] = [];
    const cumulative: number[] = [];
    for (const raw of Array.isArray(segment?.points) ? segment.points : []) {
      throwIfAborted(signal);
      rawPointCount++;
      if (!validPoint(raw)) {
        invalidPointCount++;
        continue;
      }
      validPointCount++;
      const local = toLocal(raw.lat, raw.lon, origin);
      const point: LocalPoint = { lat: raw.lat, lon: raw.lon, ...local };
      if (Number.isFinite(raw.alt)) point.alt = raw.alt!;
      if (Number.isFinite(raw.t)) point.t = raw.t!;
      if (points.length) cumulative.push(cumulative[cumulative.length - 1] + haversine(
        points[points.length - 1].lat, points[points.length - 1].lon, point.lat, point.lon
      ));
      else cumulative.push(0);
      points.push(point);
    }
    if (!points.length) continue;
    const segmentLength = cumulative[cumulative.length - 1];
    lengthM += segmentLength;
    segments.push({
      index: segmentIndex,
      id: segment?.id ?? null,
      points,
      cumulative,
      lengthM: segmentLength,
      samples: []
    });
  }

  const counts = allocateSampleCounts(segments, spacingM, maxSamples);
  const samples: SamplePoint[] = [];
  let distanceOffset = 0;
  let effectiveSpacingM = 0;
  for (let index = 0; index < segments.length; index++) {
    throwIfAborted(signal);
    const segment = segments[index];
    const count = counts[index];
    if (segment.lengthM <= DISTANCE_EPSILON_M) {
      const first = segment.points[0];
      segment.samples.push({
        ...first,
        segmentIndex: segment.index,
        segmentId: segment.id,
        segmentDistanceM: 0,
        distanceM: distanceOffset,
        weightM: 0
      });
    } else {
      for (let sampleIndex = 0; sampleIndex < count; sampleIndex++) {
        const within = segment.lengthM * sampleIndex / (count - 1);
        const point = interpolateLocal(segment.points, segment.cumulative, within, origin);
        let weightM = segment.lengthM / (count - 1);
        if (sampleIndex === 0 || sampleIndex === count - 1) weightM /= 2;
        segment.samples.push({
          ...point,
          segmentIndex: segment.index,
          segmentId: segment.id,
          segmentDistanceM: within,
          distanceM: distanceOffset + within,
          weightM
        });
        if (sampleIndex) {
          effectiveSpacingM = Math.max(effectiveSpacingM, within - segment.samples[segment.samples.length - 2].segmentDistanceM);
        }
      }
    }
    samples.push(...segment.samples);
    distanceOffset += segment.lengthM;
  }

  return { segments, samples, lengthM, rawPointCount, validPointCount, invalidPointCount, effectiveSpacingM };
}

function makeEdge(from: SamplePoint, to: SamplePoint): Edge {
  return {
    from,
    to,
    minX: Math.min(from.x, to.x),
    maxX: Math.max(from.x, to.x),
    minY: Math.min(from.y, to.y),
    maxY: Math.max(from.y, to.y)
  };
}

function trackEdges(track: PreparedTrack): Edge[] {
  const edges: Edge[] = [];
  for (const segment of track.segments) {
    if (segment.samples.length === 1) edges.push(makeEdge(segment.samples[0], segment.samples[0]));
    for (let index = 1; index < segment.samples.length; index++) {
      edges.push(makeEdge(segment.samples[index - 1], segment.samples[index]));
    }
  }
  return edges;
}

function buildGridNode(edges: Edge[], minX: number, maxX: number, minY: number, maxY: number, depth: number): GridNode {
  const node: GridNode = { minX, maxX, minY, maxY, depth, edges: [], children: null };
  if (edges.length <= GRID_LEAF_SIZE || depth >= GRID_MAX_DEPTH) {
    node.edges = edges;
    return node;
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const buckets: Edge[][] = [[], [], [], []];
  for (const edge of edges) {
    if (edge.maxX <= midX && edge.maxY <= midY) buckets[0].push(edge);
    else if (edge.maxX <= midX && edge.minY >= midY) buckets[1].push(edge);
    else if (edge.minX >= midX && edge.maxY <= midY) buckets[2].push(edge);
    else if (edge.minX >= midX && edge.minY >= midY) buckets[3].push(edge);
    else node.edges.push(edge);
  }
  if (buckets.some((bucket) => bucket.length === edges.length)) {
    node.edges = edges;
    return node;
  }
  node.children = [
    buildGridNode(buckets[0], minX, midX, minY, midY, depth + 1),
    buildGridNode(buckets[1], minX, midX, midY, maxY, depth + 1),
    buildGridNode(buckets[2], midX, maxX, minY, midY, depth + 1),
    buildGridNode(buckets[3], midX, maxX, midY, maxY, depth + 1)
  ].filter((child) => child.edges.length > 0 || !!child.children?.length);
  return node;
}

/** Adaptive square spatial grid over segment-bounded polyline edges. */
function buildSpatialGrid(track: PreparedTrack): GridNode | null {
  const edges = trackEdges(track);
  if (!edges.length) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const edge of edges) {
    minX = Math.min(minX, edge.minX);
    maxX = Math.max(maxX, edge.maxX);
    minY = Math.min(minY, edge.minY);
    maxY = Math.max(maxY, edge.maxY);
  }
  const padding = Math.max(1, (maxX - minX + maxY - minY) * 1e-9);
  return buildGridNode(edges, minX - padding, maxX + padding, minY - padding, maxY + padding, 0);
}

function heapPush(heap: GridHeapItem[], item: GridHeapItem): void {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent].distance <= item.distance) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = item;
}

function heapPop(heap: GridHeapItem[]): GridHeapItem {
  const first = heap[0];
  const last = heap.pop()!;
  if (!heap.length) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && heap[right].distance < heap[left].distance ? right : left;
    if (heap[child].distance >= last.distance) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function nodeDistance(node: GridNode, x: number, y: number): number {
  const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
  const dy = y < node.minY ? node.minY - y : y > node.maxY ? y - node.maxY : 0;
  return Math.hypot(dx, dy);
}

function samplePoint(point: LocalPoint): TrackComparisonSamplePoint {
  const output: TrackComparisonSamplePoint = { lat: point.lat, lon: point.lon };
  if (Number.isFinite(point.alt)) output.alt = point.alt!;
  if (Number.isFinite(point.t)) output.t = point.t!;
  return output;
}

function projectToEdge(point: SamplePoint, edge: Edge, origin: { lat: number; lon: number }): Projection {
  const dx = edge.to.x - edge.from.x;
  const dy = edge.to.y - edge.from.y;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - edge.from.x) * dx + (point.y - edge.from.y) * dy) / lengthSquared))
    : 0;
  if (fraction <= 1e-12) {
    return { point: samplePoint(edge.from), errorM: haversine(point.lat, point.lon, edge.from.lat, edge.from.lon) };
  }
  if (fraction >= 1 - 1e-12) {
    return { point: samplePoint(edge.to), errorM: haversine(point.lat, point.lon, edge.to.lat, edge.to.lon) };
  }
  const x = edge.from.x + dx * fraction;
  const y = edge.from.y + dy * fraction;
  const local = fromLocal(x, y, origin);
  const projected: LocalPoint = { lat: local.lat, lon: local.lon, x, y };
  if (Number.isFinite(edge.from.alt) && Number.isFinite(edge.to.alt)) {
    projected.alt = edge.from.alt! + (edge.to.alt! - edge.from.alt!) * fraction;
  }
  if (Number.isFinite(edge.from.t) && Number.isFinite(edge.to.t)) {
    projected.t = edge.from.t! + (edge.to.t! - edge.from.t!) * fraction;
  }
  return { point: samplePoint(projected), errorM: haversine(point.lat, point.lon, local.lat, local.lon) };
}

function nearestProjection(
  point: SamplePoint,
  grid: GridNode | null,
  origin: { lat: number; lon: number },
  signal?: AbortSignal
): Projection | null {
  if (!grid) return null;
  const heap: GridHeapItem[] = [{ node: grid, distance: nodeDistance(grid, point.x, point.y) }];
  let best: Projection | null = null;
  while (heap.length) {
    throwIfAborted(signal);
    const item = heapPop(heap);
    if (best && item.distance >= best.errorM) continue;
    for (const edge of item.node.edges) {
      const projection = projectToEdge(point, edge, origin);
      if (!best || projection.errorM < best.errorM) best = projection;
    }
    if (item.node.children) {
      for (const child of item.node.children) {
        const distance = nodeDistance(child, point.x, point.y);
        if (!best || distance < best.errorM) heapPush(heap, { node: child, distance });
      }
    }
  }
  return best;
}

function weightedPercentile95(rows: Evaluation['rows'], totalWeight: number): number | null {
  if (!rows.length || rows.some((row) => row.errorM == null)) return null;
  if (totalWeight <= 0) {
    const errors = rows.map((row) => row.errorM!).sort((left, right) => left - right);
    return errors[Math.max(0, Math.ceil(errors.length * 0.95) - 1)];
  }
  const sorted = [...rows].sort((left, right) => left.errorM! - right.errorM!);
  const threshold = totalWeight * 0.95;
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.sample.weightM;
    if (cumulative + 1e-9 >= threshold) return row.errorM!;
  }
  return sorted[sorted.length - 1].errorM!;
}

function lengthRatio(aLength: number, bLength: number): number {
  const longest = Math.max(aLength, bLength);
  return longest > 0 ? Math.min(aLength, bLength) / longest : 0;
}

function finiteMetric(value: any): number | null {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) ? number : null;
}

function nonnegativeMetric(value: any): number {
  const number = finiteMetric(value);
  return number != null && number >= 0 ? number : 0;
}

function splitElevationComplete(split: DistanceSplit): boolean {
  if (typeof split.elevationComplete === 'boolean') return split.elevationComplete;
  return split.netElevation != null && Number.isFinite(split.startAlt) && Number.isFinite(split.endAlt)
    && Array.isArray(split.parts) && split.parts.length > 0
    && split.parts.every((part) => part.points.length > 0 && part.points.every((point) => Number.isFinite(point.alt)));
}

function summarizeSplit(split: DistanceSplit): TrackSplitAnalysis {
  const distanceM = nonnegativeMetric(split.distance);
  const movingMs = nonnegativeMetric(split.movingMs);
  return {
    index: Number.isInteger(split.index) ? split.index : 0,
    startDistanceM: nonnegativeMetric(split.startDistance),
    endDistanceM: nonnegativeMetric(split.endDistance),
    distanceM,
    durationMs: nonnegativeMetric(split.duration),
    activeMs: nonnegativeMetric(split.activeMs),
    movingMs,
    avgSpeedMps: nonnegativeMetric(split.avgSpeed),
    maxSpeedMps: nonnegativeMetric(split.maxSpeed),
    paceSecPerKm: movingMs > 0 && distanceM > 0 ? movingMs / distanceM : null,
    ascentM: nonnegativeMetric(split.ascent),
    descentM: nonnegativeMetric(split.descent),
    startAltM: finiteMetric(split.startAlt),
    endAltM: finiteMetric(split.endAlt),
    netElevationM: finiteMetric(split.netElevation),
    avgSlopePct: finiteMetric(split.avgSlope),
    climbEfficiencyMph: finiteMetric(split.climbEfficiency),
    elevationComplete: splitElevationComplete(split),
    partial: !!split.partial
  };
}

function buildElevationAnalysis(splits: TrackSplitAnalysis[]): TrackElevationAnalysis {
  const points: TrackElevationPoint[] = [];
  for (const split of splits) {
    const complete = split.elevationComplete && Number.isFinite(split.netElevationM)
      && split.startAltM != null && split.endAltM != null;
    if (!complete) {
      const previous = points[points.length - 1];
      if (!previous || previous.altM != null || Math.abs(previous.distanceM - split.startDistanceM) > DISTANCE_EPSILON_M) {
        points.push({ distanceM: split.startDistanceM, altM: null });
      }
      continue;
    }
    const startAlt = split.startAltM!;
    const endAlt = split.endAltM!;
    const previous = points[points.length - 1];
    if (!previous || previous.altM == null || Math.abs(previous.distanceM - split.startDistanceM) > DISTANCE_EPSILON_M) {
      points.push({ distanceM: split.startDistanceM, altM: startAlt });
    }
    points.push({ distanceM: split.endDistanceM, altM: endAlt });
  }
  const altitudes = points.map((point) => point.altM).filter((alt): alt is number => alt != null);
  return {
    complete: splits.length > 0 && splits.every((split) => split.elevationComplete && split.netElevationM != null),
    minAltM: altitudes.length ? Math.min(...altitudes) : null,
    maxAltM: altitudes.length ? Math.max(...altitudes) : null,
    points
  };
}

function buildSlopeBands(splits: TrackSplitAnalysis[]): TrackSlopeBandAnalysis[] {
  const bands: TrackSlopeBandAnalysis[] = SLOPE_BANDS.map((band) => ({
    ...band, splitCount: 0, distanceM: 0, ascentM: 0, descentM: 0, movingMs: 0, climbEfficiencyMph: null
  }));
  for (const split of splits) {
    if (!split.elevationComplete || split.avgSlopePct == null) continue;
    const index = bands.findIndex((band) =>
      (band.minSlopePct == null || split.avgSlopePct! >= band.minSlopePct)
      && (band.maxSlopePct == null || split.avgSlopePct! < band.maxSlopePct));
    if (index < 0) continue;
    const band = bands[index];
    band.splitCount++;
    band.distanceM += split.distanceM;
    band.ascentM += split.ascentM;
    band.descentM += split.descentM;
    band.movingMs += split.movingMs;
  }
  for (const band of bands) {
    band.climbEfficiencyMph = band.movingMs > 0 ? band.ascentM / (band.movingMs / 3_600_000) : null;
  }
  return bands;
}

function buildProfessionalAnalysis(track: TrackComparisonInput): TrackProfessionalAnalysis {
  const requestedInterval = Number(track.splitIntervalM);
  const intervalM = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? requestedInterval
    : TRACK_COMPARISON_SPLIT_INTERVAL_M;
  const sourceSplits = track.splits != null
    ? track.splits
    : computeDistanceSplits(track.segments, intervalM, { activity: track.activity || 'hike' });
  const splits = sourceSplits.map(summarizeSplit);
  return {
    intervalM,
    durationMs: splits.reduce((sum, split) => sum + split.durationMs, 0),
    splits,
    elevation: buildElevationAnalysis(splits),
    slopeBands: buildSlopeBands(splits)
  };
}

function timeBreakpoints(analysis: TrackProfessionalAnalysis): TrackTimePoint[] {
  if (!analysis.splits.length || analysis.splits.some((split) => !(split.durationMs > 0))) return [];
  const points: TrackTimePoint[] = [{ elapsedMs: 0, distanceM: analysis.splits[0].startDistanceM }];
  let elapsedMs = 0;
  let distanceM = points[0].distanceM;
  for (const split of analysis.splits) {
    if (Math.abs(split.startDistanceM - distanceM) > DISTANCE_EPSILON_M) return [];
    elapsedMs += split.durationMs;
    distanceM = split.endDistanceM;
    points.push({ elapsedMs, distanceM });
  }
  return points;
}

function pointAtElapsed(points: TrackTimePoint[], elapsedMs: number): TrackTimePoint | null {
  if (!points.length || elapsedMs < -DISTANCE_EPSILON_M || elapsedMs > points[points.length - 1].elapsedMs + DISTANCE_EPSILON_M) return null;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].elapsedMs < elapsedMs - DISTANCE_EPSILON_M) low = middle + 1;
    else high = middle;
  }
  if (low <= 0) return { ...points[0] };
  if (low >= points.length) return { ...points[points.length - 1] };
  const next = points[low];
  if (Math.abs(next.elapsedMs - elapsedMs) <= DISTANCE_EPSILON_M) return { ...next };
  const previous = points[low - 1];
  const span = next.elapsedMs - previous.elapsedMs;
  const fraction = span > 0 ? (elapsedMs - previous.elapsedMs) / span : 0;
  return {
    elapsedMs,
    distanceM: previous.distanceM + (next.distanceM - previous.distanceM) * fraction
  };
}

function buildTimeAlignment(a: TrackProfessionalAnalysis, b: TrackProfessionalAnalysis): TrackTimeAlignmentSample[] {
  const aPoints = timeBreakpoints(a);
  const bPoints = timeBreakpoints(b);
  const durationMs = Math.max(a.durationMs, b.durationMs);
  if (!aPoints.length || !bPoints.length || !(durationMs > 0)) return [];
  return Array.from({ length: TRACK_COMPARISON_TIME_ALIGNMENT_SAMPLES }, (_, index) => {
    const progress = index / (TRACK_COMPARISON_TIME_ALIGNMENT_SAMPLES - 1);
    const elapsedMs = progress * durationMs;
    return {
      progress,
      elapsedMs,
      a: pointAtElapsed(aPoints, elapsedMs),
      b: pointAtElapsed(bPoints, elapsedMs)
    };
  });
}

function displaySegments(track: PreparedTrack): TrackComparisonSegment[] {
  return track.segments.map((segment) => ({
    id: segment.id,
    points: segment.samples.map(samplePoint) as TrackComparisonPoint[]
  }));
}

function evaluate(
  source: PreparedTrack,
  target: PreparedTrack,
  targetGrid: GridNode | null,
  origin: { lat: number; lon: number },
  toleranceM: number,
  signal?: AbortSignal
): Evaluation {
  const rows: Evaluation['rows'] = [];
  let weightedError = 0;
  let totalWeight = 0;
  let matchedDistanceM = 0;
  let matchedSampleCount = 0;
  for (const sample of source.samples) {
    const projection = nearestProjection(sample, targetGrid, origin, signal);
    const errorM = projection?.errorM ?? null;
    const matched = errorM != null && errorM <= toleranceM + 1e-9;
    rows.push({ sample, projection, errorM, matched });
    if (errorM != null) weightedError += errorM * sample.weightM;
    totalWeight += sample.weightM;
    if (matched) {
      matchedDistanceM += sample.weightM;
      matchedSampleCount++;
    }
  }
  const metricsAvailable = rows.length > 0 && rows.every((row) => row.errorM != null);
  const meanErrorM = !metricsAvailable
    ? null
    : totalWeight > 0
      ? weightedError / totalWeight
      : rows.reduce((sum, row) => sum + row.errorM!, 0) / rows.length;
  const unmatchedDistanceM = Math.max(0, source.lengthM - matchedDistanceM);
  const summary: TrackComparisonSummary = {
    meanErrorM,
    p95ErrorM: weightedPercentile95(rows, totalWeight),
    matchedRatio: source.lengthM > 0
      ? Math.max(0, Math.min(1, matchedDistanceM / source.lengthM))
      : rows.length ? matchedSampleCount / rows.length : 0,
    matchedDistanceM,
    unmatchedDistanceM,
    lengthRatio: lengthRatio(source.lengthM, target.lengthM),
    toleranceM,
    sourceLengthM: source.lengthM,
    targetLengthM: target.lengthM,
    sampleCount: rows.length,
    matchedSampleCount
  };
  return { source, target, rows, summary };
}

function limitedSamples(
  evaluation: Evaluation,
  direction: 'forward' | 'reverse',
  limit: number
): { samples: TrackAlignmentSample[]; worstSample: TrackAlignmentSample | null } {
  const rows = evaluation.rows.filter((row) => !!row.projection);
  if (!rows.length || limit <= 0) return { samples: [], worstSample: null };
  let worstIndex = 0;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].errorM! > rows[worstIndex].errorM!) worstIndex = index;
  }
  const selectedIndexes: number[] = [];
  if (rows.length <= limit) {
    for (let index = 0; index < rows.length; index++) selectedIndexes.push(index);
  } else if (limit === 1) {
    selectedIndexes.push(worstIndex);
  } else {
    for (let index = 0; index < limit; index++) {
      selectedIndexes.push(Math.round(index * (rows.length - 1) / (limit - 1)));
    }
    if (!selectedIndexes.includes(worstIndex)) {
      // Preserve the global worst projection even when uniform display sampling
      // would omit it. Replace a middle display point, never an endpoint.
      selectedIndexes.splice(Math.floor(selectedIndexes.length / 2), 1);
      selectedIndexes.push(worstIndex);
    }
    selectedIndexes.sort((left, right) => rows[left].sample.distanceM - rows[right].sample.distanceM || left - right);
  }
  let worstSample: TrackAlignmentSample | null = null;
  const samples = selectedIndexes.map((index) => {
    const row = rows[index];
    const sample: TrackAlignmentSample = {
      distanceM: row.sample.distanceM,
      errorM: row.errorM!,
      a: direction === 'forward' ? samplePoint(row.sample) : row.projection!.point,
      b: direction === 'forward' ? row.projection!.point : samplePoint(row.sample)
    };
    if (index === worstIndex) worstSample = sample;
    return sample;
  });
  return { samples, worstSample };
}

function sideSummary(track: TrackComparisonInput, prepared: PreparedTrack): TrackComparisonSideSummary {
  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    lengthM: prepared.lengthM,
    pointCount: Number.isInteger(track?.sourcePointCount) && track.sourcePointCount! >= 0
      ? track.sourcePointCount!
      : prepared.rawPointCount,
    validPointCount: prepared.validPointCount,
    invalidPointCount: prepared.invalidPointCount,
    segmentCount: Array.isArray(track?.segments) ? track.segments.length : 0,
    stats: track?.stats ?? null
  };
}

function comparisonNotes(
  a: PreparedTrack,
  b: PreparedTrack,
  spacingM: number,
  maxSamples: number
): { limitations: TrackComparisonLimitation[]; errors: TrackComparisonError[] } {
  const limitations: TrackComparisonLimitation[] = [
    {
      code: 'sampled-geometry',
      message: 'Lengths and errors use distance-resampled horizontal geometry; supplied stats are informational.'
    },
    {
      code: 'nearest-projection',
      message: 'Matches are independent nearest projections, not one-to-one or time-ordered alignments; direction is projection direction, not travel orientation, and loops or parallel routes can be ambiguous.'
    },
    {
      code: 'horizontal-only',
      message: 'Altitude and time are preserved in samples when available but do not affect matching.'
    },
    {
      code: 'local-projection',
      message: 'A local equirectangular spatial grid accelerates haversine point-to-polyline projection; very long or polar edges are approximate.'
    }
  ];
  const errors: TrackComparisonError[] = [];
  for (const [side, track] of [['a', a], ['b', b]] as const) {
    if (!track.validPointCount) {
      limitations.push({ code: 'empty-track', message: `Track ${side.toUpperCase()} has no usable horizontal points.` });
      errors.push({ side, code: 'empty-track', count: 0, message: `Track ${side.toUpperCase()} cannot be aligned.` });
    } else if (track.lengthM <= DISTANCE_EPSILON_M) {
      limitations.push({ code: 'stationary-track', message: `Track ${side.toUpperCase()} has no measurable horizontal distance.` });
    } else if (track.lengthM < spacingM) {
      limitations.push({ code: 'short-track', message: `Track ${side.toUpperCase()} is shorter than one sample interval and is represented by its endpoints.` });
    }
    if (track.invalidPointCount) {
      limitations.push({ code: 'invalid-points', message: `Track ${side.toUpperCase()} has invalid coordinates that were skipped.` });
      errors.push({
        side,
        code: 'invalid-points',
        count: track.invalidPointCount,
        message: `${track.invalidPointCount} point(s) on track ${side.toUpperCase()} had non-finite or out-of-range coordinates.`
      });
    }
  }
  if (a.samples.length > maxSamples || b.samples.length > maxSamples) {
    limitations.push({
      code: 'segment-endpoint-floor',
      message: 'Every segment endpoint is retained for gap safety, so mandatory boundary points can exceed maxSamples; returned alignment samples remain capped.'
    });
  }
  return { limitations, errors };
}

function historicalStats(trip: any): any {
  return trip?.statsCache || trip?.stats || {};
}

function historicalRouteKey(trip: any): string | null {
  const stats = historicalStats(trip);
  for (const value of [trip?.routeSignature, trip?.routeKey, trip?.routeId, trip?.sameRouteId, stats?.routeSignature, stats?.routeKey]) {
    if (value != null && value !== '') return String(value);
  }
  return null;
}

function historicalTimestamp(trip: any): number {
  const value = trip?.createdAt;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Suggest local historical comparison candidates from trip metadata only.
 * Explicit route identifiers take precedence; activity and distance provide a
 * conservative fallback. No track data leaves the device.
 */
export function suggestHistoricalTrips(trips: readonly any[] = [], currentTrip: any, limit = 3): any[] {
  const current = currentTrip?.trip ?? currentTrip;
  if (!current?.id || !Array.isArray(trips)) return [];
  const stats = historicalStats(current);
  const distance = Number(stats?.distance ?? current.distance);
  const duration = Number(stats?.duration ?? current.duration);
  const activity = String(current.activity || '').trim();
  const routeKey = historicalRouteKey(current);
  if (!Number.isFinite(distance) || !(distance > 0)) return [];
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.min(10, Math.floor(limit))) : 3;
  if (!maximum) return [];
  return trips.filter((trip) => {
    if (!trip || trip.id == null || trip.id === current.id || trip.status === 'recording' || trip.status === 'paused') return false;
    if (activity && String(trip.activity || '').trim() !== activity) return false;
    const candidateStats = historicalStats(trip);
    const candidateDistance = Number(candidateStats?.distance ?? trip.distance);
    if (!Number.isFinite(candidateDistance) || !(candidateDistance > 0)) return false;
    if (Math.abs(candidateDistance - distance) / distance > 0.2) return false;
    const candidateRouteKey = historicalRouteKey(trip);
    if (routeKey && candidateRouteKey && candidateRouteKey !== routeKey) return false;
    const candidateDuration = Number(candidateStats?.duration ?? trip.duration);
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(candidateDuration) && candidateDuration > 0
      && Math.abs(candidateDuration - duration) / duration > 0.75) return false;
    return true;
  }).map((trip) => {
    const candidateStats = historicalStats(trip);
    const candidateDistance = Number(candidateStats?.distance ?? trip.distance);
    const candidateDuration = Number(candidateStats?.duration ?? trip.duration);
    const exactRoute = !!routeKey && historicalRouteKey(trip) === routeKey;
    const distanceScore = Math.abs(candidateDistance - distance) / distance * 100;
    const durationScore = Number.isFinite(candidateDuration) && duration > 0
      ? Math.abs(candidateDuration - duration) / duration * 20
      : 0;
    return { trip, score: (exactRoute ? -1000 : 0) + distanceScore + durationScore, timestamp: historicalTimestamp(trip) };
  }).sort((left, right) => left.score - right.score || right.timestamp - left.timestamp
    || String(left.trip.id).localeCompare(String(right.trip.id)))
    .slice(0, maximum)
    .map((item) => item.trip);
}

/**
 * Compare two WGS-84 tracks without mutating them or using external services.
 * `forward` projects A onto B and `reverse` projects B onto A; the lower mean
 * horizontal error wins. Recording segments are never joined, and all metric
 * distances are horizontal metres.
 */
export function compareTracks(
  a: TrackComparisonInput,
  b: TrackComparisonInput,
  options: TrackComparisonOptions = {}
): TrackComparisonResult {
  throwIfAborted(options.signal);
  const normalized = normalizeOptions(options);
  const origin = findOrigin(a, b, options.signal);
  const preparedA = prepareTrack(a, origin, normalized.sampleSpacingM, normalized.maxSamples, options.signal);
  const preparedB = prepareTrack(b, origin, normalized.sampleSpacingM, normalized.maxSamples, options.signal);
  throwIfAborted(options.signal);

  // Quality is measured from the complete source segments, not the resampled
  // alignment geometry. In the UI this function runs in the comparison worker.
  const qualityA = a?.sourceGpsQuality ?? assessTrackGpsQuality(a?.segments || [], { activity: a?.activity || 'hike' });
  const qualityB = b?.sourceGpsQuality ?? assessTrackGpsQuality(b?.segments || [], { activity: b?.activity || 'hike' });
  const analysisA = buildProfessionalAnalysis(a);
  const analysisB = buildProfessionalAnalysis(b);
  throwIfAborted(options.signal);

  const gridA = buildSpatialGrid(preparedA);
  const gridB = buildSpatialGrid(preparedB);
  const forward = evaluate(preparedA, preparedB, gridB, origin, DEFAULT_TRACK_COMPARISON_TOLERANCE_M, options.signal);
  const reverse = evaluate(preparedB, preparedA, gridA, origin, DEFAULT_TRACK_COMPARISON_TOLERANCE_M, options.signal);
  const hasMeasurableGeometry = preparedA.lengthM > DISTANCE_EPSILON_M && preparedB.lengthM > DISTANCE_EPSILON_M;
  const metricsAvailable = [forward.summary, reverse.summary].every((summary) =>
    summary.meanErrorM != null && summary.p95ErrorM != null
  );
  const direction: TrackComparisonResult['direction'] = hasMeasurableGeometry && metricsAvailable
    ? reverse.summary.meanErrorM! + 1e-6 < forward.summary.meanErrorM! ? 'reverse' : 'forward'
    : null;
  const selected = direction === 'forward' ? forward : reverse;
  const alignmentSampleLimit = Math.min(TRACK_COMPARISON_ALIGNMENT_SAMPLE_LIMIT, normalized.maxSamples);
  const limited = direction
    ? limitedSamples(selected, direction, alignmentSampleLimit)
    : { samples: [] as TrackAlignmentSample[], worstSample: null as TrackAlignmentSample | null };
  const notes = comparisonNotes(preparedA, preparedB, normalized.sampleSpacingM, normalized.maxSamples);
  throwIfAborted(options.signal);

  return {
    direction,
    toleranceM: DEFAULT_TRACK_COMPARISON_TOLERANCE_M,
    tracks: { a: sideSummary(a, preparedA), b: sideSummary(b, preparedB) },
    summaries: { forward: forward.summary, reverse: reverse.summary },
    samples: limited.samples,
    worstSample: limited.worstSample,
    displayTracks: { a: displaySegments(preparedA), b: displaySegments(preparedB) },
    analysis: { a: analysisA, b: analysisB },
    timeAlignment: buildTimeAlignment(analysisA, analysisB),
    gpsQuality: { a: qualityA, b: qualityB },
    sampling: {
      sampleSpacingM: normalized.sampleSpacingM,
      maxSamples: normalized.maxSamples,
      alignmentSampleLimit,
      aSampleCount: preparedA.samples.length,
      bSampleCount: preparedB.samples.length,
      aEffectiveSpacingM: preparedA.effectiveSpacingM,
      bEffectiveSpacingM: preparedB.effectiveSpacingM,
      limited: preparedA.samples.length > normalized.maxSamples || preparedB.samples.length > normalized.maxSamples
    },
    limitations: notes.limitations,
    errors: notes.errors
  };
}
