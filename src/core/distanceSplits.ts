// Pure fixed-distance split analysis. Shared by the Web Worker and main-thread fallback.
import {
  ascentDescent,
  emaSeries,
  measureTrackStep,
  physicsFor,
  SPEED_TOLERANCE,
  usableTrackPoints
} from './geo';

const MOVING_SPEED = 0.5; // m/s, matching stats.ts
const MAX_DT = 60_000;    // maximum active time contributed by one step
const DISTANCE_EPSILON = 1e-6;

export interface DistanceSplitPoint {
  lat: number;
  lon: number;
  t?: number | null;
  alt?: number | null;
  [key: string]: any;
}

export interface DistanceSplitPart {
  segmentId: any;
  segmentIndex: number;
  startDistance: number;
  endDistance: number;
  points: DistanceSplitPoint[];
}

export interface DistanceSplit {
  index: number;
  distance: number;
  duration: number;
  activeMs: number;
  movingMs: number;
  ascent: number;
  descent: number;
  avgSpeed: number;
  maxSpeed: number;
  pointCount: number;
  partial: boolean;
  startDistance: number;
  endDistance: number;
  parts: DistanceSplitPart[];
}

interface SplitBuilder {
  index: number;
  startDistance: number;
  endDistance: number;
  activeMs: number;
  movingMs: number;
  maxSpeed: number;
  minT: number | null;
  maxT: number | null;
  parts: DistanceSplitPart[];
}

function finiteTime(point: DistanceSplitPoint): number | null {
  return Number.isFinite(point.t) ? point.t : null;
}

function finiteAlt(point: DistanceSplitPoint): number | null {
  return Number.isFinite(point.alt) ? point.alt : null;
}

function clonePoint(point: DistanceSplitPoint): DistanceSplitPoint {
  return { ...point };
}

/** Interpolate geometry by distance; time and altitude are linear for timed fixes. */
function interpolatePoint(
  prev: DistanceSplitPoint,
  point: DistanceSplitPoint,
  fraction: number
): DistanceSplitPoint {
  const f = Math.max(0, Math.min(1, fraction));
  const out = clonePoint({
    ...prev,
    ...point,
    lat: prev.lat + (point.lat - prev.lat) * f,
    lon: prev.lon + (point.lon - prev.lon) * f
  });
  const prevT = finiteTime(prev);
  const pointT = finiteTime(point);
  if (prevT != null && pointT != null && pointT > prevT) {
    out.t = prevT + (pointT - prevT) * f;
    const prevAlt = finiteAlt(prev);
    const pointAlt = finiteAlt(point);
    if (prevAlt != null && pointAlt != null) out.alt = prevAlt + (pointAlt - prevAlt) * f;
  }
  return out;
}

/**
 * Split a track at global distance intervals without measuring across recording
 * segment boundaries. `duration` is elapsed time; `activeMs` excludes pauses and
 * steps longer than 60 seconds, while `avgSpeed` uses moving time only.
 */
export function computeDistanceSplits(
  segments: Array<{ id?: any; points?: DistanceSplitPoint[] }> = [],
  intervalM = 1000,
  opts: any = {}
): DistanceSplit[] {
  const interval = Number.isFinite(intervalM) && intervalM > 0 ? intervalM : 1000;
  const options = opts || {};
  const activity = options.activity || 'hike';
  const speedLimit = physicsFor(activity).vmax * SPEED_TOLERANCE;
  const threshold = Number.isFinite(options.ascentThreshold) && options.ascentThreshold >= 0
    ? options.ascentThreshold
    : 4;
  const splits: DistanceSplit[] = [];
  let current: SplitBuilder | null = null;
  let totalDistance = 0;
  let nextBoundary = interval;

  function appendPoint(
    builder: SplitBuilder,
    point: DistanceSplitPoint,
    segment: { id?: any },
    segmentIndex: number,
    distance: number,
    forceNewPart = false
  ) {
    const segmentId = segment.id ?? null;
    let part = builder.parts[builder.parts.length - 1];
    if (forceNewPart || !part || part.segmentIndex !== segmentIndex || part.segmentId !== segmentId) {
      part = {
        segmentId,
        segmentIndex,
        startDistance: distance,
        endDistance: distance,
        points: []
      };
      builder.parts.push(part);
    }
    part.endDistance = distance;
    part.points.push(clonePoint(point));
    builder.endDistance = distance;
    const t = finiteTime(point);
    if (t != null) {
      if (builder.minT == null || t < builder.minT) builder.minT = t;
      if (builder.maxT == null || t > builder.maxT) builder.maxT = t;
    }
  }

  function startSplit(
    point: DistanceSplitPoint,
    segment: { id?: any },
    segmentIndex: number,
    distance = totalDistance
  ) {
    current = {
      index: splits.length,
      startDistance: distance,
      endDistance: distance,
      activeMs: 0,
      movingMs: 0,
      maxSpeed: 0,
      minT: null,
      maxT: null,
      parts: []
    };
    appendPoint(current, point, segment, segmentIndex, distance);
  }

  function addStepMetrics(
    builder: SplitBuilder,
    step: ReturnType<typeof measureTrackStep>,
    point: DistanceSplitPoint,
    fraction: number
  ) {
    if (!step.valid || !(fraction > 0)) return;
    const reported = Number.isFinite(point.speed) && point.speed >= 0 && point.speed <= speedLimit
      ? point.speed
      : null;
    const speed = step.implied ?? reported;
    if (speed != null && Number.isFinite(speed) && speed >= 0 && speed <= speedLimit) {
      builder.maxSpeed = Math.max(builder.maxSpeed, speed);
    }
    if (step.dt > 0 && step.dt <= MAX_DT) {
      const activeMs = step.dt * fraction;
      builder.activeMs += activeMs;
      if (step.implied > MOVING_SPEED) builder.movingMs += activeMs;
    }
  }

  function finishSplit(partial: boolean) {
    if (!current) return;
    const builder = current;
    current = null;
    const distance = builder.endDistance - builder.startDistance;
    if (partial ? distance <= DISTANCE_EPSILON : distance <= 0) return;

    let ascent = 0;
    let descent = 0;
    let pointCount = 0;
    for (const part of builder.parts) {
      const smoothAlt = emaSeries(part.points.map(finiteAlt), 0.35);
      const elevation = ascentDescent(smoothAlt, threshold);
      ascent += elevation.ascent;
      descent += elevation.descent;
      pointCount += part.points.length;
    }
    const duration = builder.minT != null && builder.maxT != null
      ? Math.max(0, builder.maxT - builder.minT)
      : 0;
    splits.push({
      index: builder.index,
      distance,
      duration,
      activeMs: builder.activeMs,
      movingMs: builder.movingMs,
      ascent,
      descent,
      avgSpeed: builder.movingMs > 0 ? distance / (builder.movingMs / 1000) : 0,
      maxSpeed: builder.maxSpeed,
      pointCount,
      partial,
      startDistance: builder.startDistance,
      endDistance: builder.endDistance,
      parts: builder.parts
    });
  }

  for (const [segmentIndex, segment] of (Array.isArray(segments) ? segments : []).entries()) {
    if (!segment) continue;
    const points = usableTrackPoints(segment.points || []);
    let prev: DistanceSplitPoint | null = null;
    for (const point of points) {
      if (!prev) {
        if (!current) startSplit(point, segment, segmentIndex);
        else appendPoint(current, point, segment, segmentIndex, totalDistance, true);
        prev = point;
        continue;
      }

      const step = measureTrackStep(prev, point, activity);
      const stepDistance = step.dist;
      if (!step.valid || !Number.isFinite(stepDistance) || stepDistance <= 0) {
        // Keep the fix for elapsed time/drawing, but never join an invalid jump.
        appendPoint(current, point, segment, segmentIndex, totalDistance, !step.valid);
        if (step.valid) addStepMetrics(current, step, point, 1);
        prev = point;
        continue;
      }

      const stepStart = totalDistance;
      const stepEnd = stepStart + stepDistance;
      const boundaryEpsilon = Math.min(DISTANCE_EPSILON, interval * 1e-9, stepDistance * 1e-9);
      let cursor = stepStart;
      let crossedBoundary = false;
      while (nextBoundary <= stepEnd + boundaryEpsilon) {
        crossedBoundary = true;
        const boundary = nextBoundary;
        const overlap = Math.max(0, boundary - cursor);
        addStepMetrics(current, step, point, overlap / stepDistance);
        const stepFraction = Math.min(1, (boundary - stepStart) / stepDistance);
        const boundaryPoint = interpolatePoint(prev, point, stepFraction);
        appendPoint(current, boundaryPoint, segment, segmentIndex, boundary);
        finishSplit(false);
        nextBoundary += interval;
        cursor = boundary;
        startSplit(boundaryPoint, segment, segmentIndex, boundary);
        if (boundary >= stepEnd - boundaryEpsilon) break;
      }

      if (!crossedBoundary) {
        addStepMetrics(current, step, point, 1);
        appendPoint(current, point, segment, segmentIndex, stepEnd);
        totalDistance = stepEnd;
      } else if (stepEnd > cursor + boundaryEpsilon) {
        addStepMetrics(current, step, point, (stepEnd - cursor) / stepDistance);
        appendPoint(current, point, segment, segmentIndex, stepEnd);
        totalDistance = stepEnd;
      } else {
        // Snap a near-exact boundary so roundoff cannot create a spurious partial.
        totalDistance = cursor;
      }
      prev = point;
    }
  }

  finishSplit(true);
  return splits;
}
