import { bearing, haversine, physicsFor } from './geo';
import { createJumpGate } from './trackFilter';

const GAP_MS = 60_000;
const ALT_JUMP_M = 50;
const ALT_JUMP_WINDOW_MS = 120_000;
const REVERSAL_DEG = 150;
const CLEAN_HISTORY_MS = 120_000;

function validCoords(point) {
  return isFinite(point?.lat) && isFinite(point?.lon)
    && Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function* segmentPoints(segments) {
  for (const segment of segments || []) yield* segment?.points || [];
}

export function assessTrackGpsQuality(segments, options = {}) {
  return assessGpsQuality(segmentPoints(segments), options);
}

export function assessGpsQuality(points, { poorAcc = 50, activity = 'hike' } = {}) {
  let accSum = 0, accN = 0, poorFixes = 0;
  let timedPairs = 0, gaps = 0, gapMs = 0, maxGapMs = 0;
  let altJumps = 0, reversals = 0, duplicateFixes = 0, invalidTimes = 0, fixes = 0;
  let prev = null, prevPrev = null;
  const minRevDist = physicsFor(activity).minRevDist;
  for (const p of points || []) {
    fixes++;
    const acc = Number(p?.acc);
    if (isFinite(acc) && acc > 0) {
      accSum += acc;
      accN++;
      if (acc > poorAcc) poorFixes++;
    }
    if (!Number.isFinite(p?.t) || (prev && Number.isFinite(prev.t) && p.t <= prev.t)) invalidTimes++;
    if (prev && p?.lat === prev.lat && p?.lon === prev.lon && p?.t === prev.t) duplicateFixes++;
    if (prev && Number.isFinite(p?.t) && Number.isFinite(prev.t)) {
      const dt = p.t - prev.t;
      if (dt > 0) timedPairs++;
      if (dt > GAP_MS) {
        gaps++;
        gapMs += dt;
        if (dt > maxGapMs) maxGapMs = dt;
      }
      if (dt > 0 && dt <= ALT_JUMP_WINDOW_MS && p.alt != null && prev.alt != null
        && isFinite(p.alt) && isFinite(prev.alt) && Math.abs(p.alt - prev.alt) > ALT_JUMP_M) {
        altJumps++;
      }
      if (dt > 0 && prevPrev && Number.isFinite(prevPrev.t)) {
        const firstDt = prev.t - prevPrev.t;
        const firstDist = haversine(prevPrev.lat, prevPrev.lon, prev.lat, prev.lon);
        const secondDist = haversine(prev.lat, prev.lon, p.lat, p.lon);
        if (firstDt > 0 && firstDt <= GAP_MS && dt <= GAP_MS
          && firstDist >= minRevDist && secondDist >= minRevDist) {
          const turn = Math.abs(((bearing(prevPrev.lat, prevPrev.lon, prev.lat, prev.lon)
            - bearing(prev.lat, prev.lon, p.lat, p.lon) + 540) % 360) - 180);
          if (turn > REVERSAL_DEG) reversals++;
        }
      }
    }
    prevPrev = prev;
    prev = p;
  }
  const avgAcc = accN ? accSum / accN : null;
  const poorRatio = accN ? poorFixes / accN : null;
  const hasTime = timedPairs > 0;
  const base = { fixes, avgAcc, poorFixes, poorRatio, gaps, gapMs, maxGapMs, altJumps, reversals, duplicateFixes, invalidTimes, hasTime };
  if (avgAcc == null && !hasTime) {
    return { ...base, score: null };
  }
  let penalty = 0;
  if (avgAcc != null) {
    penalty += Math.min(45, Math.max(0, (avgAcc - 5) * 2));
    penalty += (poorRatio || 0) * 25;
  }
  if (hasTime) penalty += Math.min(30, gaps * 6);
  penalty += Math.min(10, altJumps * 2);
  penalty += Math.min(35, reversals * 4);
  penalty += Math.min(15, invalidTimes * 3);
  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  return {
    fixes, avgAcc, poorFixes, poorRatio,
    gaps, gapMs, maxGapMs, altJumps, reversals, duplicateFixes, invalidTimes, hasTime, score,
    rating: score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'fair' : 'poor'
  };
}

function scanTrackCleanup(segments, activity, confirmPoints, includeCleaned) {
  const list = Array.isArray(segments) ? segments : [];
  const gate = createJumpGate({ confirmPoints });
  const cleaned = includeCleaned ? list.map((seg) => ({ ...seg, points: [] })) : null;
  const source = new Map();
  const removedPoints = includeCleaned ? [] : null;
  const removals = [];
  const grouped = new Map();
  let anchor = null;
  let history = [];
  let total = 0;
  let kept = 0;

  const recordDiscarded = (discarded, reason, currentAnchor) => {
    for (const point of discarded) {
      const location = source.get(point);
      if (!location) continue;
      const distance = currentAnchor && validCoords(currentAnchor) && validCoords(point)
        ? haversine(currentAnchor.lat, currentAnchor.lon, point.lat, point.lon) : 0;
      const removal = { ...location, reason: reason || 'unclassified', distance };
      removals.push(removal);
      if (removedPoints) removedPoints.push({ point, ...removal });
      const key = `${location.segmentIndex}:${removal.reason}`;
      let issue = grouped.get(key);
      if (!issue) {
        issue = {
          segmentId: location.segmentId, segmentIndex: location.segmentIndex,
          reason: removal.reason, count: 0, distance: 0,
          firstPoint: point, lastPoint: point
        };
        grouped.set(key, issue);
      }
      issue.count++;
      issue.distance += distance;
      if (Number.isFinite(point.t)) {
        if (!Number.isFinite(issue.firstPoint.t) || point.t < issue.firstPoint.t) issue.firstPoint = point;
        if (!Number.isFinite(issue.lastPoint.t) || point.t > issue.lastPoint.t) issue.lastPoint = point;
      }
    }
  };

  const flushPending = () => {
    const pending = gate.pendingPoints();
    if (cleaned) {
      for (const point of pending) cleaned[source.get(point).segmentIndex].points.push(point);
    }
    kept += pending.length;
    gate.reset();
  };

  for (let si = 0; si < list.length; si++) {
    gate.reset();
    let boundary = si > 0;
    const points = list[si].points || [];
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      source.set(point, { segmentId: list[si].id, segmentIndex: si, index });
      total++;
      if (!validCoords(point)) {
        flushPending();
        history = [];
        anchor = null;
        if (cleaned) cleaned[si].points.push(point);
        kept++;
        continue;
      }
      const validTime = Number.isFinite(point.t) && (!anchor || point.t > anchor.t);
      if (boundary) {
        if (cleaned) cleaned[si].points.push(point);
        kept++;
        anchor = point;
        history = validTime
          ? [...history, point].filter((p) => anchor.t - p.t <= CLEAN_HISTORY_MS).slice(-400)
          : [point];
        boundary = false;
        continue;
      }
      if (!validTime || (anchor && point.t - anchor.t > GAP_MS)) {
        flushPending();
        history = [];
        anchor = null;
        if (cleaned) cleaned[si].points.push(point);
        kept++;
        continue;
      }
      const decision = gate.evaluate({ fix: point, anchor, history, activity });
      recordDiscarded(decision.discarded || [], decision.reason, anchor);
      if (decision.action === 'pending') continue;
      for (const accepted of decision.points) {
        if (cleaned) cleaned[source.get(accepted).segmentIndex].points.push(accepted);
        kept++;
      }
      anchor = decision.points[decision.points.length - 1];
      history = [...history, ...decision.points]
        .filter((p) => anchor.t - p.t <= CLEAN_HISTORY_MS)
        .slice(-400);
    }
    flushPending();
  }

  const issues = [...grouped.values()].sort((a, b) => b.distance - a.distance);
  return {
    segments: cleaned,
    removed: total - kept,
    removedPoints,
    removals,
    issues,
    impactDistance: issues.reduce((sum, issue) => sum + issue.distance, 0)
  };
}

export function cleanTrackSegments(segments, activity = 'hike', { confirmPoints = 4 } = {}) {
  const { removals, ...result } = scanTrackCleanup(segments, activity, confirmPoints, true);
  void removals;
  return result;
}

export function previewTrackCleanup(segments, activity = 'hike', { confirmPoints = 4 } = {}) {
  const { segments: _segments, removedPoints: _removedPoints, ...preview } = scanTrackCleanup(
    segments, activity, confirmPoints, false
  );
  return { version: 1, activity, ...preview };
}

function samePoint(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const aKeys = Object.keys(a), bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key) && Object.is(a[key], b[key]));
}

export function sameTrackCleanupPreview(a, b) {
  if (!a || !b || a.version !== 1 || b.version !== 1 || a.activity !== b.activity
    || a.removed !== b.removed || !Object.is(a.impactDistance, b.impactDistance)
    || !Array.isArray(a.removals) || !Array.isArray(b.removals)
    || !Array.isArray(a.issues) || !Array.isArray(b.issues)
    || a.removals.length !== b.removals.length || a.issues.length !== b.issues.length) return false;
  for (let index = 0; index < a.removals.length; index++) {
    const left = a.removals[index], right = b.removals[index];
    if (left.segmentId !== right.segmentId || left.segmentIndex !== right.segmentIndex
      || left.index !== right.index || left.reason !== right.reason || !Object.is(left.distance, right.distance)) return false;
  }
  return a.issues.every((issue, index) => {
    const other = b.issues[index];
    return issue.segmentId === other.segmentId && issue.segmentIndex === other.segmentIndex
      && issue.reason === other.reason && issue.count === other.count
      && Object.is(issue.distance, other.distance)
      && samePoint(issue.firstPoint, other.firstPoint) && samePoint(issue.lastPoint, other.lastPoint);
  });
}

function invalidPreview() {
  throw new Error('invalid-preview');
}

export function buildTrackCleanupEdits(segments, preview) {
  if (!preview || preview.version !== 1 || !Array.isArray(preview.removals)
    || !Array.isArray(preview.issues) || !Number.isSafeInteger(preview.removed)
    || preview.removed !== preview.removals.length || !Number.isFinite(preview.impactDistance)
    || preview.impactDistance < 0 || !Array.isArray(segments)) invalidPreview();
  const removedBySegment = new Map();
  const issueCounts = new Map();
  let impact = 0;
  for (const removal of preview.removals) {
    const segment = segments[removal?.segmentIndex];
    if (!segment || segment.id !== removal.segmentId || !Number.isSafeInteger(removal.index)
      || removal.index < 1 || removal.index >= segment.points?.length
      || typeof removal.reason !== 'string' || !Number.isFinite(removal.distance) || removal.distance < 0) invalidPreview();
    let indexes = removedBySegment.get(removal.segmentIndex);
    if (!indexes) removedBySegment.set(removal.segmentIndex, indexes = new Set());
    if (indexes.has(removal.index)) invalidPreview();
    indexes.add(removal.index);
    const key = `${removal.segmentIndex}:${removal.reason}`;
    const aggregate = issueCounts.get(key) || { count: 0, distance: 0 };
    aggregate.count++;
    aggregate.distance += removal.distance;
    issueCounts.set(key, aggregate);
    impact += removal.distance;
  }
  if (Math.abs(impact - preview.impactDistance) > 1e-6) invalidPreview();
  for (const issue of preview.issues) {
    const aggregate = issueCounts.get(`${issue?.segmentIndex}:${issue?.reason}`);
    if (!aggregate || aggregate.count !== issue.count || !Object.is(aggregate.distance, issue.distance)
      || segments[issue.segmentIndex]?.id !== issue.segmentId
      || !validCoords(issue.firstPoint) || !validCoords(issue.lastPoint)) invalidPreview();
  }
  const edits = [];
  for (const [segmentIndex, indexes] of removedBySegment) {
    const segment = segments[segmentIndex];
    const after = segment.points.filter((point, index) => !indexes.has(index));
    edits.push({ segmentId: segment.id, before: segment.points, after });
  }
  return edits;
}
