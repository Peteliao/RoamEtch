import { interpolateLongitude, measureTrackStep } from './geo';
import { localDayKey } from './tripFilters';

const DAY_MS = 86_400_000;
const DISTANCE_EPSILON = 1e-6;
const TIME_EPSILON = 1e-6;
const MOVING_SPEED = 0.5;
const MAX_MOVING_DT = 60_000;

export const DEFAULT_RECORD_DISTANCES = [5000, 10000] as const;

export interface AnnualEntry {
  trip: any;
  stats: any;
  splits?: any[];
}

export interface AnnualOptions {
  /** Inclusive local day keys (YYYY-MM-DD). */
  start?: string;
  end?: string;
  /** Explicit local date for the current streak; a Date or epoch ms is also accepted. */
  asOf?: string | number | Date;
  /** Injectable clock used when asOf is omitted. */
  now?: number | Date;
}

export interface AnnualTotals {
  distance: number;
  duration: number;
  activeMs: number;
  movingMs: number;
  stillMs: number;
  breakMs: number;
  ascent: number;
  descent: number;
  tripCount: number;
  activeDays: number;
}

export interface PeriodSummary extends AnnualTotals {}

export interface MonthSummary extends PeriodSummary {
  month: number;
}

export interface WeekSummary extends PeriodSummary {
  isoYear: number;
  week: number;
  /** Local Monday day key; may fall in the preceding calendar year. */
  start: string;
  /** Local Sunday day key; may fall in the following calendar year. */
  end: string;
}

export interface DaySummary extends PeriodSummary {
  date: string;
}

export interface ActivitySummary extends PeriodSummary {
  activity: string;
  /** Share of trips, between 0 and 1. */
  ratio: number;
  distanceRatio: number;
  durationRatio: number;
}

export interface TripSummary {
  tripId: any;
  name: any;
  activity: string;
  distance: number;
  /** Elapsed time, including pauses. */
  duration: number;
  activeMs: number;
  movingMs: number;
  avgSpeed: number;
  timestamp: number | null;
  date: string;
}

export interface AnnualStreaks {
  longest: number;
  current: number;
  longestStart: string | null;
  longestEnd: string | null;
  currentStart: string | null;
  currentEnd: string | null;
}

export interface AnnualReport {
  year: number;
  asOf: string;
  totals: AnnualTotals;
  activities: ActivitySummary[];
  months: MonthSummary[];
  weeks: WeekSummary[];
  streaks: AnnualStreaks;
  /** Longest trip by distance. */
  longestTrip: TripSummary | null;
  /** Longest trip by elapsed duration. */
  longestDurationTrip: TripSummary | null;
  mostAscentDay: DaySummary | null;
}

export interface RecordPart {
  splitIndex: number;
  partIndex: number;
  segmentId: any;
  segmentIndex: number;
  startDistance: number;
  endDistance: number;
}

export interface RecordBoundary {
  distance: number;
  lat: number;
  lon: number;
  t: number;
  alt: number | null;
  segmentId: any;
  segmentIndex: number;
  partIndex: number;
  interpolated: boolean;
}

export interface RecordSource {
  splitIndexes: number[];
  parts: RecordPart[];
  /** Exact requested interval in the trip's cumulative distance coordinates. */
  startDistance: number;
  endDistance: number;
  /** Unclipped boundaries of the first and last contributing splits. */
  rawStartDistance: number;
  rawEndDistance: number;
  startBoundary: RecordBoundary;
  endBoundary: RecordBoundary;
}

export interface PersonalRecordOptions {
  /** Attribute records to the local calendar year in which the effort actually starts. */
  year?: number;
}

export interface PersonalRecord {
  distance: number;
  tripId: any;
  name: any;
  activity: string;
  /** Elapsed time between the interpolated boundaries, including pauses. */
  elapsedMs: number;
  movingMs: number;
  avgSpeed: number;
  timestamp: number;
  date: string;
  source: RecordSource;
}

type Metrics = Omit<AnnualTotals, 'tripCount' | 'activeDays'>;
type Bucket = AnnualTotals & { days: Set<string> };
type BoundaryPoint = { lat: number; lon: number; t: number; alt: number | null };

interface PreparedPoint {
  distance: number;
  movingMs: number;
  point: BoundaryPoint;
}

interface PreparedPart {
  splitIndex: number;
  partIndex: number;
  segmentId: any;
  segmentIndex: number;
  startDistance: number;
  endDistance: number;
  startPoint: BoundaryPoint;
  endPoint: BoundaryPoint;
  points: PreparedPoint[] | null;
}

interface MovingBreakpoint {
  distance: number;
  movingMs: number;
}

interface PreparedSplit {
  index: number;
  startDistance: number;
  endDistance: number;
  duration: number;
  movingMs: number;
  parts: PreparedPart[];
  detailedPoints: boolean;
  movingBreakpoints: MovingBreakpoint[];
}

interface PreparedRun {
  splits: PreparedSplit[];
  breakpoints: MovingBreakpoint[];
}

interface SelectedEntry {
  entry: AnnualEntry;
  timestamp: number;
  date: string;
  metrics: Metrics;
  order: number;
}

interface WeekMeta {
  isoYear: number;
  week: number;
  start: string;
  end: string;
  monday: number;
  bucket: Bucket;
}

function finiteNumber(value: any): number | null {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) ? number : null;
}

function finiteNonnegative(value: any): number | null {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function metricsFrom(stats: any): Metrics {
  const distance = finiteNonnegative(stats?.distance) ?? 0;
  const duration = finiteNonnegative(stats?.duration) ?? 0;
  const activeMs = finiteNonnegative(stats?.activeMs) ?? 0;
  const movingMs = finiteNonnegative(stats?.movingMs) ?? 0;
  return {
    distance,
    duration,
    activeMs,
    movingMs,
    stillMs: finiteNonnegative(stats?.stillMs) ?? Math.max(0, activeMs - movingMs),
    breakMs: finiteNonnegative(stats?.breakMs) ?? Math.max(0, duration - activeMs),
    ascent: finiteNonnegative(stats?.ascent) ?? 0,
    descent: finiteNonnegative(stats?.descent) ?? 0
  };
}

function zeroTotals(): AnnualTotals {
  return {
    distance: 0, duration: 0, activeMs: 0, movingMs: 0, stillMs: 0, breakMs: 0,
    ascent: 0, descent: 0, tripCount: 0, activeDays: 0
  };
}

function bucket(): Bucket {
  return { ...zeroTotals(), days: new Set<string>() };
}

function addMetrics(target: Metrics, source: Metrics) {
  target.distance += source.distance;
  target.duration += source.duration;
  target.activeMs += source.activeMs;
  target.movingMs += source.movingMs;
  target.stillMs += source.stillMs;
  target.breakMs += source.breakMs;
  target.ascent += source.ascent;
  target.descent += source.descent;
}

function addTrip(target: Bucket, date: string, metrics: Metrics) {
  addMetrics(target, metrics);
  target.tripCount++;
  target.days.add(date);
}

function summarize(target: Bucket): PeriodSummary {
  const { days, ...totals } = target;
  return { ...totals, activeDays: days.size };
}

function ratio(value: number, total: number) {
  return total > 0 ? value / total : 0;
}

function activityName(trip: any) {
  const value = String(trip?.activity || '').trim();
  return value || 'unknown';
}

function tripTimestamp(trip: any): number | null {
  const value = trip?.createdAt;
  if (value == null || value === '') return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validDayKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = utcDate(year, month, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function utcDate(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function dayOrdinal(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(utcDate(year, month, day).getTime() / DAY_MS);
}

function ordinalDayKey(ordinal: number) {
  const date = new Date(ordinal * DAY_MS);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function mondayOrdinal(value: string) {
  const ordinal = dayOrdinal(value);
  // 1970-01-01 was a Thursday, so its Monday-based weekday index is 3.
  return ordinal - (((ordinal + 3) % 7 + 7) % 7);
}

/** ISO week-year/week computed from the Thursday in the local Monday week. */
function isoWeek(monday: number) {
  const thursday = monday + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const firstMonday = mondayOrdinal(`${String(year).padStart(4, '0')}-01-01`);
  return { isoYear: year, week: Math.floor((thursday - firstMonday) / 7) + 1 };
}

function weekMetas(year: number): WeekMeta[] {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return [];
  const first = dayOrdinal(`${String(year).padStart(4, '0')}-01-01`);
  const last = dayOrdinal(`${String(year).padStart(4, '0')}-12-31`);
  const output: WeekMeta[] = [];
  for (let monday = mondayOrdinal(ordinalDayKey(first)); monday <= mondayOrdinal(ordinalDayKey(last)); monday += 7) {
    const { isoYear, week } = isoWeek(monday);
    output.push({
      isoYear, week, monday,
      start: ordinalDayKey(monday),
      end: ordinalDayKey(monday + 6),
      bucket: bucket()
    });
  }
  return output;
}

function resolveAsOf(options: AnnualOptions) {
  if (options.asOf != null) {
    if (typeof options.asOf === 'string') return validDayKey(options.asOf) ? options.asOf : '';
    return localDayKey(options.asOf);
  }
  return localDayKey(options.now ?? new Date());
}

function buildStreaks(days: Set<string>, asOf: string): AnnualStreaks {
  const empty: AnnualStreaks = {
    longest: 0, current: 0, longestStart: null, longestEnd: null, currentStart: null, currentEnd: null
  };
  const sorted = [...days].sort();
  let run = 0;
  let previous: number | null = null;
  for (const day of sorted) {
    const ordinal = dayOrdinal(day);
    run = previous != null && ordinal === previous + 1 ? run + 1 : 1;
    if (run > empty.longest) {
      empty.longest = run;
      empty.longestStart = ordinalDayKey(ordinal - run + 1);
      empty.longestEnd = day;
    }
    previous = ordinal;
  }

  // A current streak ends on asOf itself; an inactive asOf day contributes zero.
  if (validDayKey(asOf)) {
    const end = dayOrdinal(asOf);
    while (empty.current < sorted.length && days.has(ordinalDayKey(end - empty.current))) empty.current++;
    if (empty.current > 0) {
      empty.currentStart = ordinalDayKey(end - empty.current + 1);
      empty.currentEnd = asOf;
    }
  }
  return empty;
}

function tripSummary(entry: AnnualEntry, timestamp: number, date: string, metrics: Metrics): TripSummary {
  return {
    tripId: entry.trip?.id ?? null,
    name: entry.trip?.name ?? null,
    activity: activityName(entry.trip),
    distance: metrics.distance,
    duration: metrics.duration,
    activeMs: metrics.activeMs,
    movingMs: metrics.movingMs,
    avgSpeed: metrics.movingMs > 0 ? metrics.distance / (metrics.movingMs / 1000) : 0,
    timestamp,
    date
  };
}

/**
 * Aggregate a local-calendar year from computeStats results. Dates come from
 * trip.createdAt; invalid dates are omitted and missing metrics contribute zero.
 */
export function buildAnnualReport(entries: AnnualEntry[] = [], year: number, options: AnnualOptions = {}): AnnualReport {
  const opts = options || {};
  const asOf = resolveAsOf(opts);
  const start = opts.start == null || opts.start === '' ? '' : String(opts.start).trim();
  const end = opts.end == null || opts.end === '' ? '' : String(opts.end).trim();
  const validFilters = (!start || validDayKey(start)) && (!end || validDayKey(end)) && (!start || !end || start <= end);
  const selected: SelectedEntry[] = [];

  for (const [order, entry] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!entry?.trip) continue;
    const timestamp = tripTimestamp(entry.trip);
    if (timestamp == null) continue;
    const date = new Date(timestamp);
    const day = localDayKey(date);
    if (date.getFullYear() !== year || !validFilters) continue;
    if ((start && day < start) || (end && day > end)) continue;
    selected.push({ entry, timestamp, date: day, metrics: metricsFrom(entry.stats), order });
  }
  selected.sort((a, b) => a.timestamp - b.timestamp
    || String(a.entry.trip?.id ?? '').localeCompare(String(b.entry.trip?.id ?? '')) || a.order - b.order);

  const totals = bucket();
  const months = Array.from({ length: 12 }, () => bucket());
  const weeks = weekMetas(year);
  const weekByMonday = new Map(weeks.map((week) => [week.monday, week]));
  const days = new Map<string, Bucket>();
  const activityBuckets = new Map<string, Bucket>();
  let longestTrip: TripSummary | null = null;
  let longestDurationTrip: TripSummary | null = null;

  for (const item of selected) {
    const { entry, timestamp, date, metrics } = item;
    addTrip(totals, date, metrics);
    addTrip(months[new Date(timestamp).getMonth()], date, metrics);
    const week = weekByMonday.get(mondayOrdinal(date));
    if (week) addTrip(week.bucket, date, metrics);
    let day = days.get(date);
    if (!day) days.set(date, day = bucket());
    addTrip(day, date, metrics);
    const activity = activityName(entry.trip);
    let activityBucket = activityBuckets.get(activity);
    if (!activityBucket) activityBuckets.set(activity, activityBucket = bucket());
    addTrip(activityBucket, date, metrics);

    const summary = tripSummary(entry, timestamp, date, metrics);
    if (metrics.distance > 0 && (!longestTrip || metrics.distance > longestTrip.distance)) longestTrip = summary;
    if (metrics.duration > 0 && (!longestDurationTrip || metrics.duration > longestDurationTrip.duration)) {
      longestDurationTrip = summary;
    }
  }

  const activities = [...activityBuckets.entries()].map(([activity, value]) => ({
    activity,
    ...summarize(value),
    ratio: ratio(value.tripCount, totals.tripCount),
    distanceRatio: ratio(value.distance, totals.distance),
    durationRatio: ratio(value.duration, totals.duration)
  })).sort((a, b) => b.tripCount - a.tripCount || b.distance - a.distance || a.activity.localeCompare(b.activity));

  let mostAscentDay: DaySummary | null = null;
  for (const date of [...days.keys()].sort()) {
    const summary: DaySummary = { date, ...summarize(days.get(date)!) };
    if (summary.ascent > 0 && (!mostAscentDay || summary.ascent > mostAscentDay.ascent)) mostAscentDay = summary;
  }

  return {
    year,
    asOf,
    totals: summarize(totals),
    activities,
    months: months.map((value, index) => ({ month: index + 1, ...summarize(value) })),
    weeks: weeks.map(({ isoYear, week, start: weekStart, end: weekEnd, bucket: value }) => ({
      isoYear, week, start: weekStart, end: weekEnd, ...summarize(value)
    })),
    streaks: buildStreaks(totals.days, asOf),
    longestTrip,
    longestDurationTrip,
    mostAscentDay
  };
}

function closeDistance(a: number, b: number) {
  return Math.abs(a - b) <= DISTANCE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
}

function timeTolerance(value: number) {
  // Split interpolation can put movingMs a fraction of a microsecond above
  // elapsed time. Keep that roundoff without accepting meaningful inconsistencies.
  return Math.max(TIME_EPSILON, Math.abs(value) * 1e-9);
}

function boundaryPoint(value: any): BoundaryPoint | null {
  if (!value || !Number.isFinite(value.t) || !Number.isFinite(value.lat) || !Number.isFinite(value.lon)
    || Math.abs(value.lat) > 90 || Math.abs(value.lon) > 180) return null;
  return { lat: value.lat, lon: value.lon, t: value.t, alt: finiteNumber(value.alt) };
}

function preparePointTimeline(
  rawPoints: any[],
  startDistance: number,
  endDistance: number,
  activity: string
): PreparedPoint[] | null {
  const points: PreparedPoint[] = [];
  let measuredDistance = 0;
  let movingMs = 0;
  let previous: any = null;
  for (const raw of rawPoints) {
    const point = boundaryPoint(raw);
    if (!point || (previous && point.t <= previous.t)) return null;
    if (previous) {
      const step = measureTrackStep(previous, raw, activity);
      if (!step.valid || !Number.isFinite(step.dist) || step.dist < 0) return null;
      measuredDistance += step.dist;
      if (step.dt > 0 && step.dt <= MAX_MOVING_DT && step.implied > MOVING_SPEED) movingMs += step.dt;
    }
    points.push({ distance: startDistance + measuredDistance, movingMs, point });
    previous = raw;
  }
  if (!closeDistance(measuredDistance, endDistance - startDistance)) return null;
  points[0].distance = startDistance;
  points[points.length - 1].distance = endDistance;
  return points;
}

function appendMovingBreakpoint(breakpoints: MovingBreakpoint[], distance: number, movingMs: number) {
  const previous = breakpoints[breakpoints.length - 1];
  if (previous && closeDistance(previous.distance, distance)) {
    previous.movingMs = Math.max(previous.movingMs, movingMs);
  } else {
    breakpoints.push({ distance, movingMs });
  }
}

function prepareMovingBreakpoints(split: PreparedSplit): { detailedPoints: boolean; breakpoints: MovingBreakpoint[] } {
  const detailedPoints = split.parts.every((part) => part.points != null);
  let detailedMovingMs = 0;
  if (detailedPoints) {
    for (const part of split.parts) detailedMovingMs += part.points![part.points!.length - 1].movingMs;
  }
  if (!detailedPoints || !(detailedMovingMs > 0)
    || Math.abs(detailedMovingMs - split.movingMs) > timeTolerance(split.movingMs)) {
    return {
      detailedPoints: false,
      breakpoints: [
        { distance: split.startDistance, movingMs: 0 },
        { distance: split.endDistance, movingMs: split.movingMs }
      ]
    };
  }

  const breakpoints: MovingBreakpoint[] = [];
  const scale = split.movingMs / detailedMovingMs;
  let movingMs = 0;
  for (const [partIndex, part] of split.parts.entries()) {
    for (const [pointIndex, prepared] of part.points!.entries()) {
      const first = partIndex === 0 && pointIndex === 0;
      const last = partIndex === split.parts.length - 1 && pointIndex === part.points!.length - 1;
      appendMovingBreakpoint(
        breakpoints,
        first ? split.startDistance : last ? split.endDistance : prepared.distance,
        movingMs + prepared.movingMs * scale
      );
    }
    movingMs += part.points![part.points!.length - 1].movingMs;
  }
  // The supplied split total is authoritative; point timing only resolves its shape.
  breakpoints[breakpoints.length - 1].movingMs = split.movingMs;
  return { detailedPoints: true, breakpoints };
}

function prepareSplit(value: any, fallbackIndex: number, activity: string): PreparedSplit | null {
  if (!value) return null;
  const startDistance = Number(value.startDistance);
  const endDistance = Number(value.endDistance);
  const duration = Number(value.duration);
  const movingMs = Number(value.movingMs);
  const distance = endDistance - startDistance;
  if (!Number.isFinite(startDistance) || !Number.isFinite(endDistance) || !(distance > 0)
    || !Number.isFinite(duration) || !(duration > 0)
    || !Number.isFinite(movingMs) || !(movingMs > 0) || movingMs > duration + timeTolerance(duration)
    || !Array.isArray(value.parts) || !value.parts.length) return null;
  if (value.distance != null && (!Number.isFinite(Number(value.distance)) || !closeDistance(Number(value.distance), distance))) return null;

  const parts: PreparedPart[] = [];
  for (const [partIndex, raw] of value.parts.entries()) {
    if (!raw || !Array.isArray(raw.points) || !raw.points.length) return null;
    const partStart = Number(raw.startDistance);
    const partEnd = Number(raw.endDistance);
    const startPoint = boundaryPoint(raw.points[0]);
    const endPoint = boundaryPoint(raw.points[raw.points.length - 1]);
    if (!Number.isFinite(partStart) || !Number.isFinite(partEnd) || partEnd < partStart || !startPoint || !endPoint
      || endPoint.t < startPoint.t) return null;
    const previous = parts[parts.length - 1];
    if ((!previous && !closeDistance(partStart, startDistance))
      || (previous && !closeDistance(previous.endDistance, partStart))) return null;
    parts.push({
      splitIndex: Number.isInteger(value.index) ? value.index : fallbackIndex,
      partIndex,
      segmentId: raw.segmentId ?? null,
      segmentIndex: Number.isInteger(raw.segmentIndex) ? raw.segmentIndex : partIndex,
      startDistance: partStart,
      endDistance: partEnd,
      startPoint,
      endPoint,
      points: preparePointTimeline(raw.points, partStart, partEnd, activity)
    });
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!closeDistance(first.startDistance, startDistance) || !closeDistance(last.endDistance, endDistance)
    || !(last.endPoint.t > first.startPoint.t)) return null;
  const split: PreparedSplit = {
    index: first.splitIndex,
    startDistance,
    endDistance,
    duration,
    movingMs,
    parts,
    detailedPoints: false,
    movingBreakpoints: []
  };
  const timeline = prepareMovingBreakpoints(split);
  split.detailedPoints = timeline.detailedPoints;
  split.movingBreakpoints = timeline.breakpoints;
  return split;
}

function prepareRun(splits: PreparedSplit[]): PreparedRun {
  const breakpoints: MovingBreakpoint[] = [];
  let movingMs = 0;
  for (const split of splits) {
    for (const breakpoint of split.movingBreakpoints) {
      appendMovingBreakpoint(breakpoints, breakpoint.distance, movingMs + breakpoint.movingMs);
    }
    movingMs += split.movingMs;
  }
  return { splits, breakpoints };
}

function prepareRuns(entry: AnnualEntry): PreparedRun[] {
  const activity = activityName(entry.trip);
  const splits = (Array.isArray(entry.splits) ? entry.splits : [])
    .map((split, index) => prepareSplit(split, index, activity))
    .filter((split): split is PreparedSplit => split != null)
    .sort((a, b) => a.startDistance - b.startDistance || a.endDistance - b.endDistance || a.index - b.index);
  const runs: PreparedSplit[][] = [];
  for (const split of splits) {
    const run = runs[runs.length - 1];
    if (run && closeDistance(run[run.length - 1].endDistance, split.startDistance)) run.push(split);
    else runs.push([split]);
  }
  return runs.map(prepareRun);
}

function pointAtDistance(split: PreparedSplit, distance: number): RecordBoundary | null {
  for (const [partIndex, part] of split.parts.entries()) {
    if (distance < part.startDistance - DISTANCE_EPSILON || distance > part.endDistance + DISTANCE_EPSILON) continue;
    const exactStart = closeDistance(distance, part.startDistance);
    const exactEnd = closeDistance(distance, part.endDistance);
    const nextPart = split.parts[partIndex + 1];
    // At a shared boundary the latter part owns the start. This also avoids
    // attributing a zero-span placeholder part ahead of real geometry.
    if (nextPart && closeDistance(nextPart.startDistance, distance) && closeDistance(part.endDistance, distance)) continue;
    if (exactStart || exactEnd || !split.detailedPoints || !part.points) {
      const fraction = (distance - part.startDistance) / (part.endDistance - part.startDistance);
      const point = exactStart ? part.startPoint : exactEnd ? part.endPoint : {
        lat: part.startPoint.lat + (part.endPoint.lat - part.startPoint.lat) * fraction,
        lon: interpolateLongitude(part.startPoint.lon, part.endPoint.lon, fraction),
        t: part.startPoint.t + (part.endPoint.t - part.startPoint.t) * fraction,
        alt: part.startPoint.alt != null && part.endPoint.alt != null
          ? part.startPoint.alt + (part.endPoint.alt - part.startPoint.alt) * fraction
          : null
      };
      return {
        distance,
        ...point,
        segmentId: part.segmentId,
        segmentIndex: part.segmentIndex,
        partIndex: part.partIndex,
        interpolated: !exactStart && !exactEnd
      };
    }

    let low = 0;
    let high = part.points.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (part.points[middle].distance < distance - DISTANCE_EPSILON) low = middle + 1;
      else high = middle;
    }
    if (low < part.points.length && closeDistance(distance, part.points[low].distance)) {
      return {
        distance,
        ...part.points[low].point,
        segmentId: part.segmentId,
        segmentIndex: part.segmentIndex,
        partIndex: part.partIndex,
        interpolated: false
      };
    }
    const previous = part.points[Math.max(0, low - 1)];
    const next = part.points[Math.min(part.points.length - 1, low)];
    const span = next.distance - previous.distance;
    const fraction = span > 0 ? Math.max(0, Math.min(1, (distance - previous.distance) / span)) : 0;
    const point = {
      lat: previous.point.lat + (next.point.lat - previous.point.lat) * fraction,
      lon: interpolateLongitude(previous.point.lon, next.point.lon, fraction),
      t: previous.point.t + (next.point.t - previous.point.t) * fraction,
      alt: previous.point.alt != null && next.point.alt != null
        ? previous.point.alt + (next.point.alt - previous.point.alt) * fraction
        : null
    };
    return {
      distance,
      ...point,
      segmentId: part.segmentId,
      segmentIndex: part.segmentIndex,
      partIndex: part.partIndex,
      interpolated: true
    };
  }
  return null;
}

function movingAtDistance(breakpoints: MovingBreakpoint[], distance: number): number {
  let low = 0;
  let high = breakpoints.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (breakpoints[middle].distance < distance - DISTANCE_EPSILON) low = middle + 1;
    else high = middle;
  }
  if (low <= 0) return breakpoints[0].movingMs;
  if (low >= breakpoints.length) return breakpoints[breakpoints.length - 1].movingMs;
  const next = breakpoints[low];
  if (closeDistance(distance, next.distance)) return next.movingMs;
  const previous = breakpoints[low - 1];
  const span = next.distance - previous.distance;
  const fraction = span > 0 ? Math.max(0, Math.min(1, (distance - previous.distance) / span)) : 0;
  return previous.movingMs + (next.movingMs - previous.movingMs) * fraction;
}

function forEachCandidateStart(
  breakpoints: MovingBreakpoint[],
  target: number,
  runStart: number,
  runEnd: number,
  visit: (startDistance: number) => void
) {
  let pointIndex = 0;
  let endIndex = 0;
  let previous: number | null = null;
  while (pointIndex < breakpoints.length || endIndex < breakpoints.length) {
    const pointStart = pointIndex < breakpoints.length ? breakpoints[pointIndex].distance : Infinity;
    const endStart = endIndex < breakpoints.length ? breakpoints[endIndex].distance - target : Infinity;
    const startDistance = Math.min(pointStart, endStart);
    if (startDistance >= runStart - DISTANCE_EPSILON && startDistance <= runEnd - target + DISTANCE_EPSILON
      && (previous == null || !closeDistance(previous, startDistance))) {
      previous = startDistance;
      visit(startDistance);
    }
    while (pointIndex < breakpoints.length && closeDistance(breakpoints[pointIndex].distance, startDistance)) pointIndex++;
    while (endIndex < breakpoints.length && closeDistance(breakpoints[endIndex].distance - target, startDistance)) endIndex++;
  }
}

function makeRecord(entry: AnnualEntry, target: number, run: PreparedRun, startDistance: number, movingMs: number): PersonalRecord | null {
  const endDistance = startDistance + target;
  let low = 0;
  let high = run.splits.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (run.splits[middle].endDistance <= startDistance + DISTANCE_EPSILON) low = middle + 1;
    else high = middle;
  }
  const first = low;
  low = 0;
  high = run.splits.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (run.splits[middle].endDistance < endDistance - DISTANCE_EPSILON) low = middle + 1;
    else high = middle;
  }
  const last = low;
  if (first >= run.splits.length || last >= run.splits.length || last < first) return null;
  const startBoundary = pointAtDistance(run.splits[first], startDistance);
  const endBoundary = pointAtDistance(run.splits[last], endDistance);
  if (!startBoundary || !endBoundary || !(endBoundary.t > startBoundary.t)) return null;
  const elapsedMs = endBoundary.t - startBoundary.t;
  if (!Number.isFinite(elapsedMs) || !(elapsedMs > 0) || !Number.isFinite(movingMs) || !(movingMs > 0)) return null;
  const used = run.splits.slice(first, last + 1);
  return {
    distance: target,
    tripId: entry.trip?.id ?? null,
    name: entry.trip?.name ?? null,
    activity: activityName(entry.trip),
    elapsedMs,
    movingMs,
    avgSpeed: target / (movingMs / 1000),
    timestamp: startBoundary.t,
    date: localDayKey(startBoundary.t),
    source: {
      splitIndexes: used.map((split) => split.index),
      parts: used.flatMap((split) => split.parts.map((part) => ({
        splitIndex: part.splitIndex,
        partIndex: part.partIndex,
        segmentId: part.segmentId,
        segmentIndex: part.segmentIndex,
        startDistance: part.startDistance,
        endDistance: part.endDistance
      }))),
      startDistance,
      endDistance,
      rawStartDistance: run.splits[first].startDistance,
      rawEndDistance: run.splits[last].endDistance,
      startBoundary,
      endBoundary
    }
  };
}

function betterRecord(candidate: PersonalRecord, current: PersonalRecord | null) {
  if (!current) return true;
  if (candidate.movingMs < current.movingMs - TIME_EPSILON) return true;
  if (Math.abs(candidate.movingMs - current.movingMs) <= TIME_EPSILON) {
    if (candidate.timestamp !== current.timestamp) return candidate.timestamp < current.timestamp;
    const trip = String(candidate.tripId ?? '').localeCompare(String(current.tripId ?? ''));
    if (trip) return trip < 0;
    return candidate.source.startDistance < current.source.startDistance;
  }
  return false;
}

function localYearRange(year: number): { start: number; end: number } {
  const start = new Date(0);
  start.setFullYear(year, 0, 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(0);
  end.setFullYear(year + 1, 0, 1);
  end.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

/**
 * Fastest exact-distance efforts within single continuous prepared runs. The
 * moving-time optimum is checked at every detailed point breakpoint and at every
 * breakpoint shifted by the target distance, so either boundary may be interpolated.
 * Splits whose point timing cannot reproduce movingMs retain split-level fallback.
 * Untimed, zero/negative-duration, or provenance-free splits never create a record.
 * When a year is requested, candidate runs must overlap that local year and the
 * winning effort is attributed by its actual start time, not trip.createdAt.
 */
export function buildPersonalRecords(
  entries: AnnualEntry[] = [],
  distances: readonly number[] | PersonalRecordOptions = DEFAULT_RECORD_DISTANCES,
  options: PersonalRecordOptions | number = {}
): PersonalRecord[] {
  const recordOptions = (Array.isArray(distances) ? options : distances) as PersonalRecordOptions | number;
  const requestedDistances = Array.isArray(distances) ? distances : DEFAULT_RECORD_DISTANCES;
  const requestedYear = typeof recordOptions === 'number' ? recordOptions : recordOptions?.year;
  const yearRange = requestedYear == null
    ? null
    : Number.isInteger(requestedYear) && requestedYear >= 1 && requestedYear <= 9999
      ? localYearRange(requestedYear)
      : { start: Infinity, end: -Infinity };
  const targets = [...new Set(requestedDistances
    .map(Number).filter((distance) => Number.isFinite(distance) && distance > 0))].sort((a, b) => a - b);
  const records: PersonalRecord[] = [];
  if (!targets.length || (yearRange && !(yearRange.start < yearRange.end))) return records;
  const prepared = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.trip)
    .map((entry) => {
      let runs = prepareRuns(entry);
      if (yearRange) {
        runs = runs.filter((run) => {
          const first = run.splits[0].parts[0].startPoint.t;
          const lastRun = run.splits[run.splits.length - 1];
          const last = lastRun.parts[lastRun.parts.length - 1].endPoint.t;
          return last >= yearRange.start && first < yearRange.end;
        });
      }
      return { entry, runs };
    });

  for (const target of targets) {
    let best: PersonalRecord | null = null;
    for (const { entry, runs } of prepared) {
      for (const run of runs) {
        const runStart = run.splits[0].startDistance;
        const runEnd = run.splits[run.splits.length - 1].endDistance;
        if (runEnd - runStart < target - DISTANCE_EPSILON) continue;
        forEachCandidateStart(run.breakpoints, target, runStart, runEnd, (startDistance) => {
          const endDistance = startDistance + target;
          if (endDistance > runEnd + DISTANCE_EPSILON) return;
          const movingMs = movingAtDistance(run.breakpoints, endDistance) - movingAtDistance(run.breakpoints, startDistance);
          if (!(movingMs > 0) || (best && movingMs > best.movingMs + TIME_EPSILON)) return;
          const candidate = makeRecord(entry, target, run, startDistance, movingMs);
          if (!candidate || (yearRange && (candidate.timestamp < yearRange.start || candidate.timestamp >= yearRange.end))) return;
          if (betterRecord(candidate, best)) best = candidate;
        });
      }
    }
    if (best) records.push(best);
  }
  return records;
}
