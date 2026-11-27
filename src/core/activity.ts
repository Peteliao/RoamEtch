// Explainable activity inference. Speed is one signal; acceleration, stops,
// distance, elevation and sampling continuity determine whether it is trustworthy.
import { ACTIVITY_PHYSICS } from './geo';

export type ActivityKind = 'hike' | 'run' | 'bike' | 'drive' | 'travel';
export const ACTIVITY_CONFIDENCE_THRESHOLD = 0.56;
const ACTIVITIES: ActivityKind[] = ['hike', 'run', 'bike', 'drive', 'travel'];
const MAX_SPEED = ACTIVITY_PHYSICS.travel.vmax * 1.3;
const MOVING_SPEED = 0.5;

export interface ActivitySample {
  t?: number | null;
  speed?: number | null;             // m/s; null when the device did not report it
  distance?: number | null;          // metres since the previous accepted fix
  dt?: number | null;                // sampling interval in ms
  elevationChange?: number | null;   // metres since the previous accepted fix
  acceleration?: number | null;      // m/s², when already known
}

export type ActivityReasonCode = 'speed' | 'acceleration' | 'elevation' | 'stops' | 'distance' | 'sampling'
  | 'stationary' | 'insufficient' | 'ambiguous' | 'sparse' | 'evidence';

export interface ActivityReason {
  code: ActivityReasonCode;
  params: Record<string, number>;
  message: string;
}

export interface ActivityCandidate {
  activity: ActivityKind;
  score: number;
  confidence: number;
  reasons: ActivityReason[];
}

export interface ActivityFeatures {
  sampleCount: number;
  movingSamples: number;
  timedSamples: number;
  invalidSamples: number;
  durationMs: number | null;
  distanceM: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  gradePct: number | null;
  medianSpeed: number | null;
  p90Speed: number | null;
  maxSpeed: number | null;
  meanAbsAcceleration: number | null;
  p90AbsAcceleration: number | null;
  stayMs: number | null;
  stoppedRatio: number | null;
  medianIntervalMs: number | null;
  maxIntervalMs: number | null;
  sparseRatio: number | null;
}

export interface ActivityClassification {
  activity: ActivityKind | null;
  confidence: number;
  threshold: number;
  lowConfidence: boolean;
  candidates: ActivityCandidate[];
  reasons: ActivityReason[];
  features: ActivityFeatures;
}

export interface ActivityFeatureContext {
  elevationGainM?: number | null;
  elevationLossM?: number | null;
}

type NormalizedSample = {
  t: number | null;
  speed: number | null;
  distance: number | null;
  dt: number | null;
  elevationChange: number | null;
  acceleration: number | null;
  speedValid: boolean;
};

const finite = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const nonnegative = (value: unknown): number | null => {
  const n = finite(value);
  return n != null && n >= 0 ? n : null;
};
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const quantile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? quantile(sorted, 0.5) : null;
};

function normalizeSamples(samples: readonly (ActivitySample | number)[]): NormalizedSample[] {
  const list = Array.isArray(samples) ? samples : [];
  const normalized: NormalizedSample[] = list.map((entry) => {
    // Legacy callers supplied numbers. Missing features stay unknown rather than
    // being filled with invented timing, distance or elevation.
    if (typeof entry === 'number') {
      const speed = finite(entry);
      return {
        t: null, speed, distance: null, dt: null, elevationChange: null, acceleration: null,
        speedValid: speed != null && speed >= 0 && speed <= MAX_SPEED
      };
    }
    const speed = nonnegative(entry?.speed);
    return {
      t: finite(entry?.t),
      speed: speed != null && speed <= MAX_SPEED ? speed : null,
      distance: nonnegative(entry?.distance),
      dt: nonnegative(entry?.dt),
      elevationChange: finite(entry?.elevationChange),
      acceleration: finite(entry?.acceleration),
      speedValid: speed != null && speed <= MAX_SPEED
    };
  });
  for (let i = 1; i < normalized.length; i++) {
    const previous = normalized[i - 1], current = normalized[i];
    if (current.dt == null && previous.t != null && current.t != null && current.t > previous.t) {
      current.dt = current.t - previous.t;
    }
    if (current.acceleration == null && previous.speed != null && current.speed != null) {
      const intervalMs = current.dt ?? (previous.t != null && current.t != null && current.t > previous.t
        ? current.t - previous.t : null);
      if (intervalMs != null && intervalMs > 0) {
        current.acceleration = (current.speed - previous.speed) / (intervalMs / 1000);
      }
    }
  }
  return normalized;
}

export function extractActivityFeatures(
  samples: readonly (ActivitySample | number)[],
  context: ActivityFeatureContext = {}
): ActivityFeatures {
  const list = normalizeSamples(samples);
  const speeds = list.filter((sample) => sample.speedValid && sample.speed! > MOVING_SPEED)
    .map((sample) => sample.speed!);
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const intervals = list.map((sample) => sample.dt).filter((dt): dt is number => dt != null && dt > 0);
  const distances = list.map((sample) => sample.distance).filter((distance): distance is number => distance != null);
  const elevationChanges = list.map((sample) => sample.elevationChange)
    .filter((change): change is number => change != null);
  const accelerations = list.map((sample) => sample.acceleration)
    .filter((value): value is number => value != null).map(Math.abs);
  const sortedAccelerations = [...accelerations].sort((a, b) => a - b);
  const durationMs = intervals.length ? intervals.reduce((sum, dt) => sum + dt, 0) : null;
  const distanceM = distances.length ? distances.reduce((sum, distance) => sum + distance, 0) : null;
  const contextGain = nonnegative(context.elevationGainM);
  const contextLoss = nonnegative(context.elevationLossM);
  const measuredGain = elevationChanges.length
    ? elevationChanges.reduce((sum, change) => sum + Math.max(0, change), 0) : null;
  const measuredLoss = elevationChanges.length
    ? elevationChanges.reduce((sum, change) => sum + Math.max(0, -change), 0) : null;
  const elevationGainM = contextGain ?? measuredGain;
  const elevationLossM = contextLoss ?? measuredLoss;
  const medianIntervalMs = median(intervals);
  const sparseLimit = medianIntervalMs == null ? 60_000 : Math.max(15_000, medianIntervalMs * 3);
  const sparseCount = intervals.filter((dt) => dt > sparseLimit).length;
  const stoppedIntervals = list.filter((sample) => sample.dt != null && sample.dt > 0
    && sample.speedValid && sample.speed! <= MOVING_SPEED).map((sample) => sample.dt!);
  const movingIntervals = list.filter((sample) => sample.dt != null && sample.dt > 0
    && sample.speedValid && sample.speed! > MOVING_SPEED).map((sample) => sample.dt!);
  const classifiedIntervals = stoppedIntervals.length + movingIntervals.length;

  return {
    sampleCount: list.length,
    movingSamples: speeds.length,
    timedSamples: intervals.length,
    invalidSamples: list.filter((sample) => !sample.speedValid).length,
    durationMs,
    distanceM,
    elevationGainM,
    elevationLossM,
    gradePct: distanceM != null && distanceM > 0 && elevationGainM != null
      ? elevationGainM / distanceM * 100 : null,
    medianSpeed: sortedSpeeds.length ? quantile(sortedSpeeds, 0.5) : null,
    p90Speed: sortedSpeeds.length ? quantile(sortedSpeeds, 0.9) : null,
    maxSpeed: sortedSpeeds.length ? sortedSpeeds[sortedSpeeds.length - 1] : null,
    meanAbsAcceleration: accelerations.length
      ? accelerations.reduce((sum, value) => sum + value, 0) / accelerations.length : null,
    p90AbsAcceleration: sortedAccelerations.length ? quantile(sortedAccelerations, 0.9) : null,
    stayMs: intervals.length ? stoppedIntervals.reduce((sum, dt) => sum + dt, 0) : null,
    stoppedRatio: classifiedIntervals ? stoppedIntervals.length / classifiedIntervals : null,
    medianIntervalMs,
    maxIntervalMs: intervals.length ? Math.max(...intervals) : null,
    sparseRatio: intervals.length ? sparseCount / intervals.length : null
  };
}

function reason(
  code: ActivityReasonCode, params: Record<string, number>, message: string
): ActivityReason {
  return { code, params: Object.fromEntries(Object.entries(params).map(([key, value]) => [key, round(value)])), message };
}

function speedAffinity(activity: ActivityKind, speed: number): number {
  if (activity === 'hike') return speed <= 1.8 ? 1 : speed >= 3.2 ? 0 : 1 - (speed - 1.8) / 1.4;
  if (activity === 'run') return Math.exp(-((((speed - 3.2) / 1.4) ** 2)));
  if (activity === 'bike') return speed <= 0 ? 0 : Math.exp(-((((Math.log(speed / 7)) / 0.62) ** 2)));
  if (activity === 'drive') return speed >= 8 && speed <= 32 ? 1 : Math.exp(-((((speed - 18) / 13) ** 2)));
  return clamp((speed - 35) / 20);
}

const SPEED_RANGES: Record<ActivityKind, [number, number]> = {
  hike: [0.5, 3.2], run: [2, 5], bike: [4, 14], drive: [8, 35], travel: [35, 127.4]
};

function scoreCandidate(activity: ActivityKind, features: ActivityFeatures): ActivityCandidate {
  const speed = features.medianSpeed;
  const reasons: ActivityReason[] = [];
  let score = 0.1 + 0.65 * (speed == null ? 0 : speedAffinity(activity, speed));
  reasons.push(speed == null
    ? reason('speed', { moving: features.movingSamples, min: SPEED_RANGES[activity][0], max: SPEED_RANGES[activity][1] },
      'No usable moving-speed samples are available for comparison.')
    : reason('speed', { speed, min: SPEED_RANGES[activity][0], max: SPEED_RANGES[activity][1] },
      `${activity}: median moving speed ${speed.toFixed(1)} m/s compared with the typical ${SPEED_RANGES[activity][0]}–${SPEED_RANGES[activity][1]} m/s range.`));

  if (features.distanceM != null && features.distanceM >= 50) {
    score += 0.04;
    reasons.push(reason('distance', { distance: features.distanceM },
      `${features.distanceM.toFixed(0)} m of measured movement supports a moving activity.`));
  }
  if (features.gradePct != null && features.gradePct >= 4) {
    if (activity === 'hike') score += Math.min(0.12, features.gradePct * 0.006);
    else if (activity === 'run') score += Math.min(0.06, features.gradePct * 0.003);
    else score -= Math.min(0.22, Math.max(0, features.gradePct - 8) * 0.012);
    reasons.push(reason('elevation', { grade: features.gradePct },
      `Measured elevation gain implies a ${features.gradePct.toFixed(1)}% average grade.`));
  }
  if (features.meanAbsAcceleration != null) {
    if (activity === 'run' && features.meanAbsAcceleration >= 0.35 && features.meanAbsAcceleration <= 3) {
      score += Math.min(0.06, features.meanAbsAcceleration * 0.02);
    } else if (activity === 'hike' && features.meanAbsAcceleration <= 2.5) score += 0.02;
    else if ((activity === 'bike' || activity === 'drive') && features.meanAbsAcceleration <= 1.5) score += 0.03;
    reasons.push(reason('acceleration', { accel: features.meanAbsAcceleration },
      `Mean absolute acceleration is ${features.meanAbsAcceleration.toFixed(2)} m/s².`));
  }
  if (activity === 'drive' && features.stoppedRatio != null && features.stoppedRatio >= 0.1
    && (features.p90Speed ?? 0) >= 8) {
    score += Math.min(0.12, features.stoppedRatio * 0.3);
    reasons.push(reason('stops', { pct: features.stoppedRatio * 100 },
      `${Math.round(features.stoppedRatio * 100)}% of timed samples are stopped, consistent with stop-and-go driving.`));
  }
  return { activity, score: round(clamp(score)), confidence: 0, reasons };
}

export function classifyActivityDetailed(
  samples: readonly (ActivitySample | number)[],
  context: ActivityFeatureContext = {}
): ActivityClassification {
  const features = extractActivityFeatures(samples, context);
  const candidates = ACTIVITIES.map((activity) => scoreCandidate(activity, features))
    .sort((a, b) => b.score - a.score || ACTIVITIES.indexOf(a.activity) - ACTIVITIES.indexOf(b.activity));
  const top = candidates[0];
  const second = candidates[1];
  const margin = top.score - second.score;
  const marginFactor = 0.55 + 0.45 * clamp(margin / 0.35);
  const samplingQuality = features.medianIntervalMs == null ? 0.95
    : clamp(1 - (features.sparseRatio || 0) * 0.7 - Math.max(0, features.medianIntervalMs - 15_000) / 60_000 * 0.4, 0.1);
  const evidence = clamp(
    0.45 * clamp(features.movingSamples / 6)
    + 0.15 * clamp((features.sampleCount - 5) / 15)
    + 0.15 * (features.durationMs == null ? 0.95 : clamp(features.durationMs / 60_000))
    + 0.15 * (features.distanceM == null ? 0.95 : clamp(features.distanceM / 1000))
    + 0.1 * samplingQuality
  ) * (features.sampleCount && features.invalidSamples / features.sampleCount > 0.25 ? 0.55 : 1);
  const rawRanked = candidates.map((candidate) => ({ ...candidate, confidence: round(candidate.score * evidence * marginFactor) }));
  const rawConfidence = rawRanked[0].confidence;
  const invalidRatio = features.sampleCount ? features.invalidSamples / features.sampleCount : 1;
  const insufficient = features.sampleCount < 6 || features.movingSamples < 3 || invalidRatio > 0.25;
  const sparse = !insufficient && ((features.sparseRatio || 0) > 0.2
    || (features.medianIntervalMs != null && features.medianIntervalMs > 30_000)
    || (features.maxIntervalMs != null && features.maxIntervalMs > 60_000));
  const lowConfidence = insufficient || sparse || rawConfidence < ACTIVITY_CONFIDENCE_THRESHOLD;
  const confidenceCap = ACTIVITY_CONFIDENCE_THRESHOLD - 0.01;
  const ranked = lowConfidence
    ? rawRanked.map((candidate) => ({ ...candidate, confidence: Math.min(candidate.confidence, confidenceCap) }))
    : rawRanked;
  const confidence = ranked[0].confidence;
  const reasons = [...ranked[0].reasons];
  if (features.medianIntervalMs != null) {
    reasons.push(reason('sampling', { interval: features.medianIntervalMs, max: features.maxIntervalMs || 0 },
      `The median sampling interval is ${(features.medianIntervalMs / 1000).toFixed(1)} s; the longest interval is ${((features.maxIntervalMs || 0) / 1000).toFixed(1)} s.`));
  }
  if (features.movingSamples === 0) {
    reasons.push(reason('stationary', {}, 'No sustained movement was observed, so an activity cannot be inferred.'));
  } else if (insufficient) {
    reasons.push(reason('insufficient', { samples: features.movingSamples },
      `Only ${features.movingSamples} usable moving samples are available; at least 3 are required and excessive invalid samples reduce confidence.`));
  } else if (sparse) {
    reasons.push(reason('sparse', { interval: features.medianIntervalMs || 0 },
      'Sampling is sparse or irregular, so the activity estimate is not applied.'));
  } else if (lowConfidence && evidence < 0.7) {
    reasons.push(reason('evidence', { confidence },
      `Only ${features.sampleCount} samples with limited measured duration or distance are available, so the current activity is kept.`));
  } else if (lowConfidence) {
    reasons.push(reason('ambiguous', { margin: margin * 100 },
      `The leading candidates are too close (${(margin * 100).toFixed(1)} percentage points), so the current activity is kept.`));
  }
  return {
    activity: lowConfidence ? null : ranked[0].activity,
    confidence,
    threshold: ACTIVITY_CONFIDENCE_THRESHOLD,
    lowConfidence,
    candidates: ranked,
    reasons,
    features: Object.fromEntries(Object.entries(features).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])) as ActivityFeatures
  };
}

/** Backwards-compatible activity-only API. New callers should use classifyActivityDetailed. */
export function classifyActivity(samples: readonly (ActivitySample | number)[]): ActivityKind | null {
  return classifyActivityDetailed(samples).activity;
}
