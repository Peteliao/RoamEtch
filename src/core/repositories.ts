// Storage boundaries used by features that should not know about Dexie.
// Sync, backup and UI code depend on these contracts rather than raw tables.
import {
  addSegment, addWaypoint, appendPoints, createTrip, db, deleteSegment, deleteTrip, getTrip,
  listTrips, listSegments, listWaypoints, loadTripFull,
  updateTrip, updateWaypoint, deleteWaypoint
} from './store';
import { exportBackup, inspectBackup, restoreBackup } from './backup';
export type { RouteRepository } from './routeRepository';
export { routeRepository } from './routeRepository';
export type { SyncDataRepository } from './syncDataRepository';
export { DexieSyncDataRepository, syncDataRepository } from './syncDataRepository';

export interface TripRepository {
  list(): Promise<any[]>;
  get(id: string): Promise<any>;
  create(input: any): Promise<any>;
  update(id: string, patch: any, options?: { touch?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
  loadFull(id: string): Promise<any>;
  listSegments(tripId: string): Promise<any[]>;
  addSegment(tripId: string, startTime?: number): Promise<any>;
  appendPoints(segmentId: string, tripId: string, points: any[], options?: { allowUnpublished?: boolean }): Promise<void>;
  deleteSegment(id: string): Promise<void>;
  addWaypoint(waypoint: any): Promise<any>;
  updateWaypoint(id: string, patch: any): Promise<any>;
  deleteWaypoint(id: string): Promise<any>;
  listWaypoints(tripId: string): Promise<any[]>;
  listMedia(tripId: string): Promise<any[]>;
}

export interface MediaRepository {
  listForTrip(tripId: string): Promise<any[]>;
}

export interface BackupService {
  export(options?: { password?: string }): Promise<any>;
  inspect(file: File | Blob, password?: string): Promise<any>;
  restore(file: File | Blob, strategy: string, inspected?: any): Promise<number>;
}

export const tripRepository: TripRepository = {
  list: () => listTrips(),
  get: (id) => getTrip(id),
  create: (input) => createTrip(input),
  update: (id, patch, options) => updateTrip(id, patch, options),
  delete: (id) => deleteTrip(id),
  loadFull: (id) => loadTripFull(id),
  listSegments,
  addSegment,
  appendPoints,
  deleteSegment,
  addWaypoint,
  updateWaypoint,
  deleteWaypoint,
  listWaypoints,
  listMedia: (tripId) => db.media.where('tripId').equals(tripId).toArray()
};

export const mediaRepository: MediaRepository = {
  listForTrip: (tripId) => db.media.where('tripId').equals(tripId).toArray()
};

export const backupService: BackupService = {
  export: (options) => exportBackup(options),
  inspect: (file, password) => inspectBackup(file, password),
  restore: (file, strategy, inspected) => restoreBackup(file, strategy, inspected)
};
