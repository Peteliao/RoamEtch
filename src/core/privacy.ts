// Privacy sanitization (non-destructive, applied at preview/export time):
// start/end privacy circles, sensitive waypoint hiding. EXIF already stripped at import.
import { haversine } from './geo';

export type PrivacyOptions = {
  radius?: number;
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

function insideCircles(lat: number, lon: number, circles: any[], radius: number) {
  return circles.some((circle) => !outsideCircle(lat, lon, circle, radius)
    && haversine(lat, lon, circle.lat, circle.lon) <= radius);
}

function resolveCircles(full: any, radius: number, anchorStart?: any, anchorEnd?: any) {
  let start = anchorStart;
  let end = anchorEnd;
  const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
  if (safeRadius > 0 && (!start || !end)) {
    for (const segment of full.segments) {
      if (!segment.points.length) continue;
      if (!anchorStart) start ||= segment.points[0];
      if (!anchorEnd) end = segment.points[segment.points.length - 1];
    }
  }
  const circles: any[] = [];
  let invalidAnchor = false;
  for (const point of [start, end]) {
    if (!point) continue;
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)
      || Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
      invalidAnchor = true;
      continue;
    }
    if (!circles.some((circle) => circle.lat === point.lat && circle.lon === point.lon)) circles.push(point);
  }
  return { safeRadius, circles: safeRadius > 0 ? circles : [], start, invalidAnchor };
}

function collectCircleBreaks(from: any, to: any, circle: any, radius: number, breaks: number[], hidden: Array<[number, number]>) {
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
        breaks.push((inside + outside) / 2);
      } else if (insideA !== insideMiddle) {
        breaks.push(a, b);
        hidden.push([a, b]);
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

export function countPrivacyCrops(full: any, { radius = 300, hideSensitive = true, start: anchorStart, end: anchorEnd }: PrivacyOptions = {}) {
  let croppedWaypoints = 0;
  const hasPoints = full.segments.some((segment) => segment.points.length);
  const { safeRadius, circles, start, invalidAnchor } = hasPoints
    ? resolveCircles(full, radius, anchorStart, anchorEnd)
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
  if (cropWaypoints) {
    for (const segment of full.segments) {
      for (const point of segment.points || []) if (inCircle(point.lat, point.lon)) croppedPoints++;
    }
  }
  for (const waypoint of full.waypoints) {
    if ((hideSensitive && waypoint.hidden) || (cropWaypoints && inCircle(waypoint.lat, waypoint.lon))) croppedWaypoints++;
  }
  return { croppedPoints, croppedWaypoints };
}

export function applyPrivacy(full, { radius = 300, hideSensitive = true, start: anchorStart, end: anchorEnd }: PrivacyOptions = {}) {
  if (!full.segments.some((segment) => segment.points.length)) {
    return { segments: [], waypoints: hideSensitive ? full.waypoints.filter((w) => !w.hidden) : full.waypoints, croppedPoints: 0, croppedWaypoints: 0 };
  }
  const { safeRadius, circles, invalidAnchor } = resolveCircles(full, radius, anchorStart, anchorEnd);
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
  const segments = [];
  if (safeRadius > 0 && circles.length) {
    for (const seg of full.segments) {
      const points = seg.points || [];
      if (points.length < 2) continue;
      croppedPoints += points.filter((point) => inCircle(point.lat, point.lon)).length;
      const breaks = points.map((_, index) => index);
      const hidden: Array<[number, number]> = [];
      for (let index = 0; index < points.length - 1; index++) {
        for (const circle of circles) {
          collectCircleBreaks(points[index], points[index + 1], circle, safeRadius, breaks, hidden);
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