import { db } from './store';
import { indexTripForFilters, type TripFilterIndex } from './tripFilters';

export async function buildTripFilterIndex(trips: any[], signal?: AbortSignal): Promise<TripFilterIndex[]> {
  const counts = new Map<string, { hasPhotos: boolean; waypointCount: number }>();
  const known = new Set((trips || []).map((trip) => trip.id));
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };
  throwIfAborted();
  await db.waypoints.orderBy('tripId').each((waypoint: any) => {
    throwIfAborted();
    if (!known.has(waypoint.tripId)) return;
    const current = counts.get(waypoint.tripId) || { hasPhotos: false, waypointCount: 0 };
    current.waypointCount++;
    if (waypoint.type === 'photo' || waypoint.mediaIds?.length) current.hasPhotos = true;
    counts.set(waypoint.tripId, current);
  });
  throwIfAborted();
  return trips.map((trip) => indexTripForFilters(trip, counts.get(trip.id) || { hasPhotos: false, waypointCount: 0 }));
}
