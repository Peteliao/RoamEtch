// Route read boundary. Uses a namespace import so lightweight UI tests can
// mock only the call they exercise without loading every storage export.
import * as store from './store';

export interface RouteRepository {
  load(tripId: string, knownTrip?: any, options?: { cooperative?: boolean }): Promise<any>;
  preview(tripId: string): Promise<any>;
  segments(tripId: string): Promise<any[]>;
}

export const routeRepository: RouteRepository = {
  load: (tripId, knownTrip, options) => (knownTrip === undefined && options === undefined
    ? store.loadTripTrack(tripId)
    : store.loadTripTrack(tripId, knownTrip, options)),
  preview: (tripId) => store.loadTripPreview(tripId),
  segments: (tripId) => store.listSegments(tripId)
};
