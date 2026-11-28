// Privacy sanitization (non-destructive, applied at preview/export time):
// start/end privacy circles, sensitive waypoint hiding. EXIF already stripped at import.
import { haversine } from './geo';

export type PrivacyOptions = {
  radius?: number;
  mode?: 'all' | 'ends';
  offset?: boolean;
  seed?: string;
  hideSensitive?: boolean;
  hideStartIcon?: boolean;
  hideEndIcon?: boolean;
  start?: any;
  end?: any;
};

/**
 * @param {{trip, segments, waypoints}} full
 * @param {PrivacyOptions} opts
 * @returns {{segments, waypoints, croppedPoints, croppedWaypoints}}
 */
function wrapLongitude(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function interpolatePoint(from: any, to: any, fraction: number) {
  return {
    ...from,
    lat: from.lat + (to.lat - from.lat) * fraction,
    lon: wrapLongitude(from.lon + wrapLongitude(to.lon - from.lon) * fraction)
  };
}

const EARTH_RADIUS = 6_371_008.8;
const RADIANS = Math.PI / 180;

function outsideCircle(lat: number, lon: number, circle: any, radius: number) {
  const latitudeDelta = Math.abs(lat - circle.lat) * RADIANS;
  if (latitudeDelta > radius / EARTH_RADIUS) return true;
  const longitudeDelta = wrapLongitude(lon - circle.lon) * RADIANS;
  const minimumCosine = Math.cos(Math.max(Math.abs(lat), Math.abs(circle.lat)) * RADIANS);
  const haversineLowerBound = Math.sin(latitudeDelta / 2) ** 2
    + minimumCosine ** 2 * Math.sin(longitudeDelta / 2) ** 2;
  return haversineLowerBound > Math.sin(radius / (2 * EARTH_RADIUS)) ** 2;
}

function insideCircle(lat: number, lon: number, circle: any, radius: number) {
  return !outsideCircle(lat, lon, circle, radius)
    && haversine(lat, lon, circle.lat, circle.lon) <= radius;
}

function insideCircles(lat: number, lon: number, circles: any[], radius: number) {
  return circles.some((circle) => insideCircle(lat, lon, circle, radius));
}

function seedHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function offsetCircle(point: any, radius: number, seed: string) {
  const hash = seedHash(seed);
  const angle = (hash % 3600) / 3600 * Math.PI * 2;
  const distance = radius * 0.25;
  const lat = point.lat + Math.sin(angle) * distance / EARTH_RADIUS / RADIANS;
  const lon = wrapLongitude(point.lon + Math.cos(angle) * distance / EARTH_RADIUS / RADIANS
    / Math.max(0.15, Math.cos(point.lat * RADIANS)));
  return { ...point, lat, lon };
}

function resolveCircles(full: any, radius: number, anchorStart?: any, anchorEnd?: any, offset = false, seed = '') {
  let start = anchorStart;
  let end = anchorEnd;
  const requestedRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const safeRadius = offset && requestedRadius > 0 ? requestedRadius * 1.25 : requestedRadius;
  if (safeRadius > 0 && (!start || !end)) {
    for (const segment of full.segments) {
      if (!segment.points.length) continue;
      if (!anchorStart) start ||= segment.points[0];
      if (!anchorEnd) end = segment.points[segment.points.length - 1];
    }
  }
  const anchors: any[] = [];
  let invalidAnchor = false;
  for (const point of [start, end]) {
    if (!point) continue;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)
      || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
      invalidAnchor = true;
      continue;
    }
    if (!anchors.some((anchor) => anchor.lat === point.lat && anchor.lon === point.lon)) anchors.push(point);
  }
  const tripSeed = seed || String(full.trip?.id || '');
  const circles = safeRadius > 0
    ? anchors.map((point, index) => offset ? offsetCircle(point, requestedRadius, `${tripSeed}:${index}`) : point)
    : [];
  return { safeRadius, circles, start, invalidAnchor };
}

function collectCircleBreaks(from: any, to: any, circle: any, radius: number, breaks: number[], hidden: Array<[number, number]>, offset = 0) {
  const latitudeLimit = radius / EARTH_RADIUS / RADIANS;
  if ((from.lat > circle.lat + latitudeLimit && to.lat > circle.lat + latitudeLimit)
    || (from.lat < circle.lat - latitudeLimit && to.lat < circle.lat - latitudeLimit)) return;
  const radians = Math.PI / 180;
  const pointAt = (fraction: number) => interpolatePoint(from, to, fraction);
  const distanceAt = (fraction: number) => {
    const point = pointAt(fraction);
    return haversine(point.lat, point.lon, circle.lat, circle.lon);
  };
  const visit = (a: number, b: number, distanceA: number, distanceB: number, depth: number) => {
    const insideA = distanceA <= radius;
    const insideB = distanceB <= radius;
    const pointA = pointAt(a), pointB = pointAt(b);
    const length = haversine(pointA.lat, pointA.lon, pointB.lat, pointB.lon);
    const latitudeSpan = Math.abs(pointB.lat - pointA.lat);
    const longitudeSpan = Math.abs(wrapLongitude(pointB.lon - pointA.lon));
    const maxCosine = pointA.lat * pointB.lat <= 0 ? 1 : Math.max(Math.abs(Math.cos(pointA.lat * radians)), Math.abs(Math.cos(pointB.lat * radians)));
    const lengthUpper = 6_371_008.8 * radians * Math.hypot(latitudeSpan, maxCosine * longitudeSpan);
    if (insideA && insideB && Math.min(distanceA, distanceB) + lengthUpper <= radius + 1e-6) return;
    if (!insideA && !insideB && distanceA + distanceB > length + radius * 2 + 1e-6) return;
    if (depth >= 30 || lengthUpper <= 0.001) {
      const middle = (a + b) / 2;
      const distanceMiddle = distanceAt(middle);
      const insideMiddle = distanceMiddle <= radius;
      if (insideA !== insideB) {
        let inside = insideA ? a : b;
        let outside = insideA ? b : a;
        for (let iteration = 0; iteration < 32; iteration++) {
          const candidate = (inside + outside) / 2;
          if (distanceAt(candidate) <= radius) inside = candidate;
          else outside = candidate;
        }
        breaks.push(offset + (inside + outside) / 2);
      } else if (insideA !== insideMiddle) {
        breaks.push(offset + a, offset + b);
        hidden.push([offset + a, offset + b]);
      }
      return;
    }
    const middle = (a + b) / 2;
    const distanceMiddle = distanceAt(middle);
    visit(a, middle, distanceA, distanceMiddle, depth + 1);
    visit(middle, b, distanceMiddle, distanceB, depth + 1);
  };
  visit(0, 1, distanceAt(0), distanceAt(1), 0);
}

function pointAtPosition(points: any[], position: number) {
  if (Number.isInteger(position)) return points[Math.min(points.length - 1, position)];
  const index = Math.min(points.length - 2, Math.floor(position));
  return interpolatePoint(points[index], points[index + 1], position - index);
}

function circleBreaks(points: any[], circle: any, radius: number) {
  const breaks: number[] = [];
  const hidden: Array<[number, number]> = [];
  for (let index = 0; index < points.length - 1; index++) {
    collectCircleBreaks(points[index], points[index + 1], circle, radius, breaks, hidden, index);
  }
  return breaks.sort((a, b) => a - b).filter((value, index, list) => index === 0 || value - list[index - 1] > 1e-10);
}

function sliceTrack(points: any[], from: number, to: number) {
  const out: any[] = [];
  let kept = 0;
  for (let index = 0; index < points.length; index++) {
    if (index >= from - 1e-10 && index <= to + 1e-10) kept++;
  }
  if (!Number.isInteger(from)) out.push(pointAtPosition(points, from));
  for (let index = Math.ceil(from); index <= Math.floor(to); index++) out.push(points[index]);
  if (!Number.isInteger(to) && to > from) out.push(pointAtPosition(points, to));
  return { points: out, kept };
}

function trimTrackStart(points: any[], circle: any, radius: number) {
  if (!insideCircle(points[0].lat, points[0].lon, circle, radius)) return { points, kept: points.length };
  for (const position of circleBreaks(points, circle, radius)) {
    const before = pointAtPosition(points, Math.max(0, position - 1e-7));
    const after = pointAtPosition(points, Math.min(points.length - 1, position + 1e-7));
    if (insideCircle(before.lat, before.lon, circle, radius) && !insideCircle(after.lat, after.lon, circle, radius)) {
      return sliceTrack(points, position, points.length - 1);
    }
  }
  return { points: [], kept: 0 };
}

function trimTrackEnd(points: any[], circle: any, radius: number) {
  if (!insideCircle(points[points.length - 1].lat, points[points.length - 1].lon, circle, radius)) {
    return { points, kept: points.length };
  }
  const breaks = circleBreaks(points, circle, radius);
  for (let index = breaks.length - 1; index >= 0; index--) {
    const position = breaks[index];
    const before = pointAtPosition(points, Math.max(0, position - 1e-7));
    const after = pointAtPosition(points, Math.min(points.length - 1, position + 1e-7));
    if (!insideCircle(before.lat, before.lon, circle, radius) && insideCircle(after.lat, after.lon, circle, radius)) {
      return sliceTrack(points, 0, position);
    }
  }
  return { points: [], kept: 0 };
}

function cropTrackEnds(full: any, circles: any[], radius: number) {
  const usable = full.segments.filter((segment: any) => (segment.points?.length || 0) >= 2);
  if (!usable.length || !circles.length) return { segments: usable, croppedPoints: 0 };
  const prepared = usable.map((segment: any) => ({
    segment, points: segment.points, kept: segment.points.length
  }));
  let trimmingStart = true;
  for (const item of prepared) {
    if (!trimmingStart || !circles[0]) continue;
    const result = trimTrackStart(item.points, circles[0], radius);
    item.points = result.points;
    item.kept = result.kept;
    if (result.points.length >= 2) trimmingStart = false;
  }
  let trimmingEnd = true;
  for (let index = prepared.length - 1; index >= 0; index--) {
    const item = prepared[index];
    if (item.points.length < 2 || !trimmingEnd || !circles[circles.length - 1]) continue;
    const beforeLength = item.points.length;
    const result = trimTrackEnd(item.points, circles[circles.length - 1], radius);
    item.kept = Math.max(0, item.kept - (beforeLength - result.kept));
    item.points = result.points;
    if (result.points.length >= 2) trimmingEnd = false;
  }
  const segments: any[] = [];
  let croppedPoints = 0;
  for (const item of prepared) {
    croppedPoints += item.segment.points.length - item.kept;
    if (item.points.length >= 2) {
      const changed = item.kept < item.segment.points.length;
      segments.push({ ...item.segment, id: changed ? `${item.segment.id}-p${segments.length}` : item.segment.id, points: item.points });
    }
  }
  return { segments, croppedPoints };
}

export function countPrivacyCrops(full: any, {
  radius = 300, mode = 'all', offset = false, seed = '', hideSensitive = true, start: anchorStart, end: anchorEnd
}: PrivacyOptions = {}) {
  const hasPoints = full.segments.some((segment) => segment.points.length);
  const { safeRadius, circles, start, invalidAnchor } = hasPoints
    ? resolveCircles(full, radius, anchorStart, anchorEnd, offset, seed)
    : { safeRadius: 0, circles: [], start: null, invalidAnchor: false };
  const blocked = hasPoints && safeRadius > 0 && (invalidAnchor || circles.length === 0);
  if (blocked) {
    return {
      croppedPoints: full.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0),
      croppedWaypoints: full.waypoints.length
    };
  }
  const cropWaypoints = hasPoints && (safeRadius <= 0 || !!start);
  if (!cropWaypoints) return { croppedPoints: 0, croppedWaypoints: 0 };
  const inCircle = (lat, lon) => insideCircles(lat, lon, circles, safeRadius);
  let croppedPoints = 0;
  if (mode === 'ends' && safeRadius > 0) {
    croppedPoints = cropTrackEnds(full, circles, safeRadius).croppedPoints;
  } else if (cropWaypoints) {
    for (const segment of full.segments) {
      for (const point of segment.points || []) if (inCircle(point.lat, point.lon)) croppedPoints++;
    }
  }
  let croppedWaypoints = 0;
  for (const waypoint of full.waypoints) {
    if ((hideSensitive && waypoint.hidden) || (cropWaypoints && inCircle(waypoint.lat, waypoint.lon))) croppedWaypoints++;
  }
  return { croppedPoints, croppedWaypoints };
}

export function applyPrivacy(full, {
  radius = 300, mode = 'all', offset = false, seed = '', hideSensitive = true, start: anchorStart, end: anchorEnd
}: PrivacyOptions = {}) {
  if (!full.segments.some((segment) => segment.points.length)) {
    return { segments: [], waypoints: hideSensitive ? full.waypoints.filter((w) => !w.hidden) : full.waypoints, croppedPoints: 0, croppedWaypoints: 0 };
  }
  const { safeRadius, circles, invalidAnchor } = resolveCircles(full, radius, anchorStart, anchorEnd, offset, seed);
  if (safeRadius > 0 && (invalidAnchor || circles.length === 0)) {
    return {
      segments: [],
      waypoints: [],
      croppedPoints: full.segments.reduce((sum, segment) => sum + (segment.points?.length || 0), 0),
      croppedWaypoints: full.waypoints.length
    };
  }
  const inCircle = (lat, lon) => insideCircles(lat, lon, circles, safeRadius);

  let croppedPoints = 0;
  let segments: any[] = [];
  if (mode === 'ends' && safeRadius > 0 && circles.length) {
    const cropped = cropTrackEnds(full, circles, safeRadius);
    segments = cropped.segments;
    croppedPoints = cropped.croppedPoints;
  } else if (safeRadius > 0 && circles.length) {
    segments = [];
    for (const seg of full.segments) {
      const points = seg.points || [];
      if (points.length < 2) continue;
      croppedPoints += points.filter((point) => inCircle(point.lat, point.lon)).length;
      const breaks = points.map((_, index) => index);
      const hidden: Array<[number, number]> = [];
      for (let index = 0; index < points.length - 1; index++) {
        for (const circle of circles) {
          collectCircleBreaks(points[index], points[index + 1], circle, safeRadius, breaks, hidden, index);
        }
      }
      breaks.sort((a, b) => a - b);
      const uniqueBreaks = breaks.filter((value, index) => index === 0 || value - breaks[index - 1] > 1e-10);
      let run: any[] = [];
      const flush = () => {
        if (run.length >= 2) segments.push({ id: seg.id + '-p' + segments.length, points: run });
        run = [];
      };
      const pointAt = (position: number) => {
        if (Number.isInteger(position)) return points[Math.min(points.length - 1, position)];
        const index = Math.min(points.length - 2, Math.floor(position));
        return interpolatePoint(points[index], points[index + 1], position - index);
      };
      const outsideEndpoint = (position: number, outside: number) => {
        let insideFraction = position;
        let outsideFraction = outside;
        for (let iteration = 0; iteration < 32; iteration++) {
          const middle = (insideFraction + outsideFraction) / 2;
          const point = pointAt(middle);
          if (inCircle(point.lat, point.lon)) insideFraction = middle;
          else outsideFraction = middle;
        }
        return pointAt(outsideFraction);
      };
      for (let index = 0; index < uniqueBreaks.length - 1; index++) {
        const from = uniqueBreaks[index], to = uniqueBreaks[index + 1];
        const middle = (from + to) / 2;
        const middlePoint = pointAt(middle);
        if (hidden.some(([from, to]) => middle > from && middle < to) || inCircle(middlePoint.lat, middlePoint.lon)) {
          flush();
          continue;
        }
        const first = pointAt(from), last = pointAt(to);
        const startPoint = inCircle(first.lat, first.lon) ? outsideEndpoint(from, middle) : first;
        const endPoint = inCircle(last.lat, last.lon) ? outsideEndpoint(to, middle) : last;
        if (run.length && Math.abs(run[run.length - 1].lat - startPoint.lat) < 1e-12
          && Math.abs(wrapLongitude(run[run.length - 1].lon - startPoint.lon)) < 1e-12) run.pop();
        run.push(startPoint, endPoint);
      }
      flush();
    }
  } else {
    segments.push(...full.segments.filter((segment) => segment.points.length >= 2));
  }

  let croppedWaypoints = 0;
  const waypoints = full.waypoints.filter((w) => {
    if (hideSensitive && w.hidden) { croppedWaypoints++; return false; }
    if (inCircle(w.lat, w.lon)) { croppedWaypoints++; return false; }
    return true;
  });

  return { segments, waypoints, croppedPoints, croppedWaypoints };
}