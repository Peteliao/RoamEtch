import { computeStats } from './stats';
import { haversine, simplify } from './geo';
import { previewTrackCleanup } from './gpsQuality';

const GAP_MS = 60_000;
const ALTITUDE_WINDOW_MS = 120_000;
const STATIONARY_MIN_POINTS = 8;
const STATIONARY_MAX_POINTS = 25;
const OVERLAY_LIMIT = 4000;
const OVERLAY_SAMPLE_LIMIT = OVERLAY_LIMIT * 2;

interface SegmentRef {
  id: string;
  point: any;
  segmentId: string;
  segmentIndex: number;
  index: number;
}

interface SuggestionOptions {
  id?: string;
  keepPointId?: string | null;
  impactDistance?: number;
  confidence?: number;
  reason?: string;
  detail?: Record<string, any>;
}

export const TRACK_REPAIR_CATEGORIES = [
  { id: 'invalid-coordinate', action: 'drop', defaultSelected: true, priority: 100 },
  { id: 'invalid-time', action: 'drop', defaultSelected: false, priority: 90 },
  { id: 'duplicate-fix', action: 'drop', defaultSelected: true, priority: 80 },
  { id: 'stationary-walk', action: 'collapse', defaultSelected: false, priority: 70 },
  { id: 'altitude-jump', action: 'clear-altitude', defaultSelected: true, priority: 40 },
  { id: 'jump-speed', action: 'drop', defaultSelected: true, priority: 30 },
  { id: 'jump-accel', action: 'drop', defaultSelected: true, priority: 30 },
  { id: 'jump-reversal', action: 'drop', defaultSelected: true, priority: 30 },
  { id: 'jump-history', action: 'drop', defaultSelected: true, priority: 30 },
  { id: 'jump-unclassified', action: 'drop', defaultSelected: false, priority: 30 },
  { id: 'gap-pause', action: 'classify', defaultSelected: false, priority: 0 },
  { id: 'gap-location-loss', action: 'classify', defaultSelected: false, priority: 0 },
  { id: 'gap-sampling', action: 'classify', defaultSelected: false, priority: 0 },
  { id: 'gap-unknown', action: 'classify', defaultSelected: false, priority: 0 }
] as const;

type RepairCategoryId = typeof TRACK_REPAIR_CATEGORIES[number]['id'];

const CATEGORY_BY_ID = new Map(TRACK_REPAIR_CATEGORIES.map((category) => [category.id, category]));
const JUMP_CATEGORY = {
  speed: 'jump-speed', accel: 'jump-accel', reversal: 'jump-reversal',
  history: 'jump-history', unclassified: 'jump-unclassified'
};

export const TRACK_REPAIR_METRIC_SEMANTICS = {
  basis: 'repaired-points',
  distance: 'sum-of-valid-horizontal-steps',
  duration: 'first-to-last-valid-timestamp',
  movingMs: 'sum-of-valid-steps-up-to-60s-above-0.5m/s',
  breakMs: 'duration-minus-active-time',
  gaps: 'classified-only-never-interpolated',
  ascent: 'smoothed-altitude-with-4m-hysteresis'
};

function validCoords(point) {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function accuracy(point) {
  const value = Number(point?.acc);
  return Number.isFinite(value) && value > 0 ? value : 15;
}

function numberText(value) {
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : Object.is(value, -0) ? '-0' : String(value);
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return `${typeof value}:${String(value)}`;
}

function pointKey(point) {
  if (!point || typeof point !== 'object') return numberText(point);
  return Object.keys(point).sort().map((key) => `${key}=${numberText(point[key])}`).join(';');
}

function hashText(text) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function sourceRefs(segments): { bySegment: SegmentRef[][]; fingerprint: string } {
  const occurrences = new Map<string, number>();
  const bySegment: SegmentRef[][] = [];
  const fingerprint = { value: 0x811c9dc5 };
  fingerprintUpdate(fingerprint, `track-repair-v1:${segments.length}`);
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    fingerprintUpdate(fingerprint, `${segmentIndex}:${segment?.id}:${segment?.index}:${segment?.points?.length || 0}`);
    const segmentRefs: SegmentRef[] = [];
    for (let index = 0; index < (segment?.points?.length || 0); index++) {
      const point = segment.points[index];
      const key = pointKey(point);
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      const id = `${segment.id}:${hashText(key)}:${occurrence}`;
      const ref = { id, point, segmentId: segment.id, segmentIndex, index };
      segmentRefs.push(ref);
      fingerprintUpdate(fingerprint, id);
    }
    bySegment.push(segmentRefs);
  }
  return { bySegment, fingerprint: fingerprint.value.toString(36) };
}

function fingerprintUpdate(state, value) {
  for (let index = 0; index < value.length; index++) {
    state.value = Math.imul(state.value ^ value.charCodeAt(index), 0x01000193);
  }
}

function distance(a, b) {
  return validCoords(a) && validCoords(b) ? haversine(a.lat, a.lon, b.lat, b.lon) : 0;
}

function pathDistance(points) {
  let total = 0;
  for (let index = 1; index < points.length; index++) total += distance(points[index - 1], points[index]);
  return total;
}

function suggestion(categoryId: RepairCategoryId, refs: SegmentRef[], options: SuggestionOptions = {}) {
  const category = CATEGORY_BY_ID.get(categoryId);
  if (!category) throw new Error('unknown-repair-category');
  const first = refs[0];
  const last = refs[refs.length - 1];
  return {
    id: options.id || `${categoryId}:${first.id}`,
    category: categoryId,
    action: category.action,
    segmentId: first.segmentId,
    segmentIndex: first.segmentIndex,
    indexes: refs.map((ref) => ref.index),
    pointIds: refs.map((ref) => ref.id),
    keepPointId: options.keepPointId || null,
    firstPoint: first.point,
    lastPoint: last.point,
    impactDistance: options.impactDistance ?? 0,
    confidence: options.confidence ?? 0.9,
    reason: options.reason || categoryId,
    detail: options.detail || {}
  };
}

function supplementalSuggestions(segments, bySegment: SegmentRef[][]) {
  const suggestions = [];
  const bestByIndex = new Map<string, any>();
  const priority = (category: RepairCategoryId) => CATEGORY_BY_ID.get(category).priority;
  const add = (candidate) => {
    const key = `${candidate.segmentIndex}:${candidate.indexes.join(',')}`;
    const current = bestByIndex.get(key);
    if (!current || priority(candidate.category) > priority(current.category)) bestByIndex.set(key, candidate);
  };

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const points = Array.isArray(segment?.points) ? segment.points : [];
    const refs = bySegment[segmentIndex] || [];
    let previous = null;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      if (!validCoords(point)) {
        add(suggestion('invalid-coordinate', [refs[index]], {
          confidence: 1,
          reason: 'coordinate-outside-wgs84-range',
          impactDistance: previous ? distance(previous, point) : 0
        }));
        previous = null;
        continue;
      }
      if (previous && Number.isFinite(point.t) && Number.isFinite(previous.t)
        && point.lat === previous.lat && point.lon === previous.lon && point.t === previous.t) {
        add(suggestion('duplicate-fix', [refs[index]], {
          confidence: 1,
          reason: 'identical-coordinate-and-timestamp',
          impactDistance: 0
        }));
      } else if (!Number.isFinite(point.t) || (previous && Number.isFinite(previous.t) && point.t <= previous.t)) {
        add(suggestion('invalid-time', [refs[index]], {
          confidence: 0.75,
          reason: Number.isFinite(point.t) ? 'timestamp-not-increasing' : 'timestamp-missing-or-invalid',
          impactDistance: previous ? distance(previous, point) : 0,
          detail: { timestamp: point.t ?? null, previousTimestamp: previous?.t ?? null }
        }));
      }
      if (previous && Number.isFinite(previous.t) && Number.isFinite(point.t)) {
        const dt = point.t - previous.t;
        const horizontal = distance(previous, point);
        if (dt > 0 && dt <= ALTITUDE_WINDOW_MS && Number.isFinite(previous.alt) && Number.isFinite(point.alt)
          && horizontal <= 100 && Math.abs(point.alt - previous.alt) > Math.max(50, dt / 1000 * 12)) {
          add(suggestion('altitude-jump', [refs[index]], {
            confidence: 0.85,
            reason: 'altitude-change-exceeds-plausible-rate',
            impactDistance: 0,
            detail: { altitudeDelta: point.alt - previous.alt, elapsedMs: dt, horizontalDistance: horizontal }
          }));
        }
        if (dt > GAP_MS) {
          const avgAcc = (accuracy(previous) + accuracy(point)) / 2;
          const category = horizontal <= Math.max(25, avgAcc * 1.5) ? 'gap-pause'
            : dt <= 120_000 ? 'gap-sampling'
              : dt >= 300_000 || horizontal <= Math.max(150, avgAcc * 6) ? 'gap-location-loss'
                : 'gap-unknown';
          add(suggestion(category, [refs[index - 1], refs[index]], {
            confidence: category === 'gap-unknown' ? 0.5 : 0.8,
            reason: category,
            impactDistance: horizontal,
            detail: { elapsedMs: dt, horizontalDistance: horizontal, averageAccuracy: avgAcc }
          }));
        }
      }
      previous = point;
    }

    let start = 0;
    while (start + STATIONARY_MIN_POINTS <= points.length) {
      let end = start + 1;
      while (end < points.length && end - start < STATIONARY_MAX_POINTS
        && Number.isFinite(points[end].t) && Number.isFinite(points[start].t)
        && points[end].t - points[start].t <= ALTITUDE_WINDOW_MS) end++;
      const window = refs.slice(start, end);
      const span = Number(window[window.length - 1].point.t) - Number(window[0].point.t);
      if (window.length >= STATIONARY_MIN_POINTS && span >= 20_000 && span <= ALTITUDE_WINDOW_MS
        && window.every((ref) => validCoords(ref.point))) {
        const origin = window[0].point;
        const radii = window.map((ref) => distance(origin, ref.point));
        const maxRadius = Math.max(...radii);
        const averageAccuracy = window.reduce((sum, ref) => sum + accuracy(ref.point), 0) / window.length;
        const radiusLimit = Math.max(50, Math.min(100, averageAccuracy * 2.5));
        const path = pathDistance(window.map((ref) => ref.point));
        const displacement = distance(origin, window[window.length - 1].point);
        if (maxRadius <= radiusLimit && displacement <= 50 && path >= 180) {
          let medoid = window[0];
          let medoidDistance = Infinity;
          for (const candidate of window) {
            const total = window.reduce((sum, ref) => sum + distance(candidate.point, ref.point), 0);
            if (total < medoidDistance) { medoid = candidate; medoidDistance = total; }
          }
          add(suggestion('stationary-walk', window, {
            id: `stationary-walk:${window[0].id}:${window[window.length - 1].id}`,
            keepPointId: medoid.id,
            confidence: 0.7,
            reason: 'high-jitter-path-with-small-net-displacement',
            impactDistance: path,
            detail: { spanMs: span, pathDistance: path, displacement, radius: maxRadius, averageAccuracy }
          }));
          start = end;
          continue;
        }
      }
      start++;
    }
  }
  suggestions.push(...bestByIndex.values());
  return suggestions;
}

function collectSuggestions(segments, activity) {
  const source = sourceRefs(segments);
  const supplemental = supplementalSuggestions(segments, source.bySegment);
  const byPoint = new Map();
  for (const item of supplemental) {
    if (item.action === 'drop' && item.indexes.length === 1) {
      byPoint.set(`${item.segmentIndex}:${item.indexes[0]}`, item);
    }
  }
  const jumpPreview = previewTrackCleanup(segments, activity || 'hike');
  const suggestions = [...supplemental];
  for (const removal of jumpPreview.removals) {
    const key = `${removal.segmentIndex}:${removal.index}`;
    if (byPoint.has(key)) continue;
    const ref = source.bySegment[removal.segmentIndex]?.[removal.index];
    if (!ref) continue;
    suggestions.push(suggestion(JUMP_CATEGORY[removal.reason] || 'jump-unclassified', [ref], {
      confidence: removal.reason === 'unclassified' ? 0.5 : 0.9,
      reason: removal.reason,
      impactDistance: removal.distance
    }));
  }
  suggestions.sort((a, b) => a.segmentIndex - b.segmentIndex
    || a.indexes[0] - b.indexes[0] || a.category.localeCompare(b.category));
  return { ...source, suggestions };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return numberText(value);
}

export function normalizeRepairSelection(selected) {
  if (!Array.isArray(selected)) throw new Error('invalid-repair-selection');
  const unique = [...new Set(selected)];
  if (unique.some((category) => !CATEGORY_BY_ID.has(category))) throw new Error('invalid-repair-selection');
  return unique.sort();
}

export function applyTrackRepairs(segments, suggestions, selected) {
  if (!Array.isArray(segments) || !Array.isArray(suggestions)) throw new Error('invalid-repair-plan');
  const selection = new Set(normalizeRepairSelection(selected));
  const drops = new Map();
  const altitudeClears = new Map();
  let removed = 0;
  let cleared = 0;
  const applied = new Set();
  for (const item of suggestions) {
    if (!selection.has(item.category) || !CATEGORY_BY_ID.has(item.category)) continue;
    if (item.action === 'classify') { applied.add(item.category); continue; }
    const segment = segments[item.segmentIndex];
    if (!segment || segment.id !== item.segmentId || !Array.isArray(item.indexes)
      || item.indexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= segment.points.length)) {
      throw new Error('invalid-repair-plan');
    }
    applied.add(item.category);
    if (item.action === 'clear-altitude') {
      let indexes = altitudeClears.get(item.segmentIndex);
      if (!indexes) altitudeClears.set(item.segmentIndex, indexes = new Set());
      for (const index of item.indexes) indexes.add(index);
    } else if (item.action === 'drop' || item.action === 'collapse') {
      let indexes = drops.get(item.segmentIndex);
      if (!indexes) drops.set(item.segmentIndex, indexes = new Set());
      for (const index of item.indexes) {
        if (item.action !== 'collapse' || item.pointIds[item.indexes.indexOf(index)] !== item.keepPointId) indexes.add(index);
      }
    }
  }
  const repaired = segments.map((segment, segmentIndex) => {
    const dropped = drops.get(segmentIndex);
    const clearedAlt = altitudeClears.get(segmentIndex);
    if (!dropped?.size && !clearedAlt?.size) return segment;
    const points = [];
    for (let index = 0; index < segment.points.length; index++) {
      if (dropped?.has(index)) { removed++; continue; }
      const point = segment.points[index];
      if (clearedAlt?.has(index) && point.alt != null) {
        const copy = { ...point };
        delete copy.alt;
        points.push(copy);
        cleared++;
      } else points.push(point);
    }
    return { ...segment, points };
  });
  return { segments: repaired, removed, altitudeCleared: cleared, applied: [...applied].sort() };
}

function overlayLine(points): [number, number][] {
  const usable = points.filter(validCoords);
  if (usable.length < 2) return [];
  let sampled = usable;
  if (usable.length > OVERLAY_SAMPLE_LIMIT) {
    const stride = (usable.length - 1) / (OVERLAY_SAMPLE_LIMIT - 1);
    sampled = Array.from({ length: OVERLAY_SAMPLE_LIMIT }, (_, index) => usable[Math.round(index * stride)]);
  }
  let simplified = simplify(sampled, 2);
  if (simplified.length > OVERLAY_LIMIT) {
    const stride = Math.ceil(simplified.length / OVERLAY_LIMIT);
    simplified = simplified.filter((_, index) => index % stride === 0 || index === simplified.length - 1);
  }
  return simplified.map((point) => [point.lon, point.lat]);
}

function metricsSummary(stats) {
  return {
    distance: stats.distance, duration: stats.duration, activeMs: stats.activeMs,
    movingMs: stats.movingMs, stillMs: stats.stillMs, breakMs: stats.breakMs,
    ascent: stats.ascent, descent: stats.descent, pointCount: stats.pointCount,
    segmentCount: stats.segCount
  };
}

export function buildTrackRepairPreview(segments, activity = 'hike', { selected = null } = {}) {
  if (!Array.isArray(segments)) throw new Error('invalid-track');
  const resolvedActivity = activity || 'hike';
  const source = collectSuggestions(segments, resolvedActivity);
  const categories = TRACK_REPAIR_CATEGORIES.map((category) => {
    const items = source.suggestions.filter((item) => item.category === category.id);
    return {
      ...category,
      count: items.length,
      impactDistance: items.reduce((sum, item) => sum + item.impactDistance, 0)
    };
  }).filter((category) => category.count > 0);
  const resolvedSelection = normalizeRepairSelection(selected == null
    ? categories.filter((category) => category.defaultSelected).map((category) => category.id)
    : selected);
  const applied = applyTrackRepairs(segments, source.suggestions, resolvedSelection);
  const before = computeStats(segments, { activity: resolvedActivity, series: false });
  const after = computeStats(applied.segments, { activity: resolvedActivity, series: false });
  const plan = {
    version: 2,
    algorithm: 'track-repair-v1',
    activity: resolvedActivity,
    sourceFingerprint: source.fingerprint,
    sourcePoints: before.pointCount,
    suggestions: source.suggestions,
    categories,
    selected: resolvedSelection,
    summary: {
      removed: applied.removed,
      altitudeCleared: applied.altitudeCleared,
      classifiedGaps: source.suggestions.filter((item) => item.action === 'classify').length,
      impactDistance: source.suggestions.filter((item) => resolvedSelection.includes(item.category))
        .reduce((sum, item) => sum + item.impactDistance, 0)
    },
    metrics: { before: metricsSummary(before), after: metricsSummary(after), semantics: TRACK_REPAIR_METRIC_SEMANTICS },
    overlay: {
      before: segments.map((segment) => overlayLine(segment.points)),
      after: applied.segments.map((segment) => overlayLine(segment.points))
    }
  };
  return { ...plan, previewId: hashText(`${source.fingerprint}:${stableSerialize({ selected: resolvedSelection, suggestions: source.suggestions })}`) };
}

export function sameTrackRepairPreview(left, right) {
  return !!left && !!right && left.version === 2 && right.version === 2
    && left.algorithm === right.algorithm && left.activity === right.activity
    && left.sourceFingerprint === right.sourceFingerprint && left.previewId === right.previewId
    && stableSerialize(left.selected) === stableSerialize(right.selected)
    && stableSerialize(left.suggestions) === stableSerialize(right.suggestions)
    && stableSerialize(left.categories) === stableSerialize(right.categories)
    && left.sourcePoints === right.sourcePoints
    && stableSerialize(left.summary) === stableSerialize(right.summary)
    && stableSerialize(left.metrics) === stableSerialize(right.metrics)
    && stableSerialize(left.overlay) === stableSerialize(right.overlay);
}

export function buildTrackRepairEdits(segments, preview) {
  if (!preview || preview.version !== 2 || !Array.isArray(preview.suggestions) || !Array.isArray(preview.selected)) {
    throw new Error('invalid-repair-preview');
  }
  const result = applyTrackRepairs(segments, preview.suggestions, preview.selected);
  return segments.map((segment, index) => ({
    segmentId: segment.id,
    before: segment.points,
    after: result.segments[index].points
  })).filter((edit) => edit.before !== edit.after);
}
