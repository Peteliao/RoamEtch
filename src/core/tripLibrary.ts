import { collectWaypointCounts } from './store';
import { indexTripForFilters, type TripFilterIndex } from './tripFilters';

export async function buildTripFilterIndex(trips: any[], signal?: AbortSignal): Promise<TripFilterIndex[]> {
  const counts = await collectWaypointCounts((trips || []).map((trip) => trip.id), signal);
  return trips.map((trip) => indexTripForFilters(trip, counts.get(trip.id) || { hasPhotos: false, waypointCount: 0 }));
}
