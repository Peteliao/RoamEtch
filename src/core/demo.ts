// Built-in onboarding trip: a synthetic loop with elevation and waypoints so a
// first-time visitor can explore analysis, posters and video without GPS.
import { createTrip, addSegment, appendPoints, addWaypoint, updateTrip, listTrips } from './store';
import { t } from './i18n';

const POINT_COUNT = 360;
const STEP_MS = 15_000;
const CENTER = { lat: 39.995, lon: 116.185 };

export function buildDemoPoints(now = Date.now()) {
  const pts = [];
  const t0 = now - 2 * 3600_000 - POINT_COUNT * STEP_MS;
  for (let i = 0; i <= POINT_COUNT; i++) {
    const th = (i / POINT_COUNT) * Math.PI * 2;
    const r = 0.011 + 0.004 * Math.sin(th * 3 + 0.7) + 0.0015 * Math.sin(th * 7);
    const lon = CENTER.lon + r * Math.cos(th) * 1.3;
    const lat = CENTER.lat + r * Math.sin(th);
    const alt = 120 + 400 * (0.5 + 0.5 * Math.sin(th * 2 - 0.9)) + 12 * Math.sin(th * 11);
    pts.push({
      lat,
      lon,
      alt: Math.round(alt * 10) / 10,
      altSrc: 'svc',
      t: t0 + i * STEP_MS,
      acc: 6,
      speed: null
    });
  }
  return pts;
}

export function buildDemoWaypoints(points, labels) {
  const at = (fraction, name, type) => {
    const p = points[Math.min(points.length - 1, Math.round(fraction * (points.length - 1)))];
    return { lat: p.lat, lon: p.lon, alt: p.alt, time: p.t, name, desc: '', type };
  };
  return [
    at(0, labels.start, 'start'),
    at(0.25, labels.view, 'view'),
    at(0.5, labels.photo, 'photo'),
    at(0.72, labels.food, 'food'),
    at(1, labels.end, 'end')
  ];
}

export async function importDemoTrip() {
  const existing = (await listTrips()).find((trip) => trip.demo);
  if (existing) return existing;
  const points = buildDemoPoints();
  const trip = await createTrip({
    name: t('demo.name'),
    activity: 'hike',
    status: 'finished',
    createdAt: points[0].t
  });
  const segment = await addSegment(trip.id, points[0].t);
  await appendPoints(segment.id, trip.id, points);
  const waypoints = buildDemoWaypoints(points, {
    start: t('demo.wpStart'),
    view: t('demo.wpView'),
    photo: t('demo.wpPhoto'),
    food: t('demo.wpFood'),
    end: t('demo.wpEnd')
  });
  for (const waypoint of waypoints) await addWaypoint({ ...waypoint, tripId: trip.id });
  await updateTrip(trip.id, { hasTime: true, demo: true });
  return { ...trip, hasTime: true, demo: true };
}
