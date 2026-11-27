import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitTrackEdits, db, deleteTrip, fillTrackChunkAltitudes, firstSegmentChunkFrom
} from '../src/core/store';
import {
  backupService, mediaRepository, routeRepository, syncDataRepository, tripRepository
} from '../src/core/repositories';

const points = [
  { lat: 30, lon: 120, alt: 10, t: 1, acc: 4 },
  { lat: 30.001, lon: 120.001, alt: 12, t: 2, acc: 4 }
];

let tripId = '';
let segmentId = '';

beforeEach(async () => {
  await db.delete();
  await db.open();
  const trip = await tripRepository.create({ name: 'Contract', activity: 'hike', status: 'finished' });
  tripId = trip.id;
  const segment = await tripRepository.addSegment(tripId, 1);
  segmentId = segment.id;
  await tripRepository.appendPoints(segmentId, tripId, points);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('TripRepository contract', () => {
  it('creates, reads, updates and deletes a trip with route and waypoint data', async () => {
    expect(await tripRepository.get(tripId)).toMatchObject({ id: tripId, name: 'Contract', activity: 'hike' });
    expect((await tripRepository.list()).map((trip) => trip.id)).toContain(tripId);

    const waypoint = await tripRepository.addWaypoint({
      tripId, lat: 30.0005, lon: 120.0005, name: 'Point', desc: '', type: 'custom'
    });
    await tripRepository.updateWaypoint(waypoint.id, { name: 'Renamed' });

    const full = await tripRepository.loadFull(tripId);
    expect(full.trip.id).toBe(tripId);
    expect(full.segments[0].points).toEqual(points);
    expect(full.waypoints).toHaveLength(1);
    expect((await tripRepository.listWaypoints(tripId))[0].name).toBe('Renamed');
    expect(await tripRepository.listSegments(tripId)).toHaveLength(1);

    await tripRepository.update(tripId, { name: 'Updated' });
    expect((await tripRepository.get(tripId)).name).toBe('Updated');

    await tripRepository.deleteWaypoint(waypoint.id);
    expect(await tripRepository.listWaypoints(tripId)).toHaveLength(0);

    await tripRepository.delete(tripId);
    expect(await tripRepository.get(tripId)).toBeUndefined();
  });

  it('exposes media through the media boundary', async () => {
    await db.media.add({ id: 'm1', tripId, type: 'photo', blob: new Blob(['x']) });
    await db.media.add({ id: 'm2', tripId: 'other', type: 'photo', blob: new Blob(['y']) });
    const rows = await mediaRepository.listForTrip(tripId);
    expect(rows.map((row) => row.id)).toEqual(['m1']);
    expect((await tripRepository.listMedia(tripId)).map((row) => row.id)).toEqual(['m1']);
  });
});

describe('RouteRepository contract', () => {
  it('loads full routes and segment summaries without leaking storage details', async () => {
    const loaded = await routeRepository.load(tripId);
    expect(loaded.trip.id).toBe(tripId);
    expect(loaded.segments[0].points).toEqual(points);
    expect((await routeRepository.segments(tripId))[0].id).toBe(segmentId);

    const preview = await routeRepository.preview(tripId);
    expect(preview.trip.id).toBe(tripId);
    expect(preview.segments.length).toBe(1);
  });

  it('returns null for a missing route', async () => {
    expect(await routeRepository.load('missing')).toBeNull();
  });
});

describe('SyncDataRepository contract', () => {
  it('pages rows and applies get, put and delete by table', async () => {
    expect(await syncDataRepository.allTrips()).toHaveLength(1);
    expect(await syncDataRepository.countRows('trips')).toBe(1);
    expect(await syncDataRepository.countRows('waypoints')).toBe(0);

    const seen: string[] = [];
    await syncDataRepository.eachRow('trips', (row) => { seen.push(row.id); });
    expect(seen).toEqual([tripId]);

    const row = await syncDataRepository.getRow('trips', tripId);
    expect(row.name).toBe('Contract');
    await syncDataRepository.putRow('trips', { ...row, name: 'Synced' });
    expect((await syncDataRepository.getRow('trips', tripId)).name).toBe('Synced');

    await syncDataRepository.putRow('waypoints', { id: 'w1', tripId, lat: 1, lon: 2 });
    expect(await syncDataRepository.countRows('waypoints')).toBe(1);
    await syncDataRepository.deleteRow('waypoints', 'w1');
    expect(await syncDataRepository.countRows('waypoints')).toBe(0);

    await deleteTrip(tripId);
  });
});

describe('Store track transaction helpers', () => {
  it('commits guarded point edits, snapshots and rejects stale revisions', async () => {
    const next = [{ ...points[0], lon: 121 }, points[1]];
    const updated = await commitTrackEdits(tripId, {
      edits: [{ segmentId, before: points, after: next }],
      useAfter: true,
      expectedUpdatedAt: (await tripRepository.get(tripId)).updatedAt,
      verify: (track) => track.segments[0].points.length === 2,
      saveSnapshot: true,
      snapshotSegments: [{ id: segmentId, index: 0, points }]
    });
    expect(updated).toBeNull();
    expect((await routeRepository.load(tripId)).segments[0].points).toEqual(next);
    expect(await db.trackSnapshots.where('tripId').equals(tripId).count()).toBeGreaterThan(0);

    const revision = (await tripRepository.get(tripId)).updatedAt;
    await expect(commitTrackEdits(tripId, {
      edits: [{ segmentId, before: points, after: points }],
      useAfter: true,
      expectedUpdatedAt: revision - 1,
      verify: () => true
    })).rejects.toThrow('track-changed');
    await expect(commitTrackEdits(tripId, {
      edits: [{ segmentId, before: points, after: points }],
      useAfter: true,
      expectedUpdatedAt: revision,
      verify: () => false
    })).rejects.toThrow('track-changed');
  });

  it('merges altitude fills into the latest persisted chunk', async () => {
    const segment = await tripRepository.addSegment(tripId, 3);
    const missing = [
      { lat: 30.002, lon: 120.002, alt: null, t: 3 },
      { lat: 30.003, lon: 120.003, alt: 9, t: 4 }
    ];
    await tripRepository.appendPoints(segment.id, tripId, missing);
    const chunk = await firstSegmentChunkFrom(segment.id, 0);
    const fills = new Map([[0, { lat: missing[0].lat, lon: missing[0].lon, t: missing[0].t, alt: 123, src: 'svc' }]]);
    await expect(fillTrackChunkAltitudes(tripId, chunk.id, fills)).resolves.toBe(1);
    const loaded = await routeRepository.load(tripId);
    const filled = loaded.segments.find((row) => row.id === segment.id);
    expect(filled.points[0]).toMatchObject({ alt: 123, altSrc: 'svc' });
    expect(filled.points[1].alt).toBe(9);
  });
});

describe('BackupService contract', () => {
  it('exports an archive that can be inspected without restoring it', async () => {
    const exported = await backupService.export();
    expect(exported.tripCount).toBe(1);
    expect(exported.filename).toMatch(/^roametch-backup-\d{8}\.trip$/);
    expect(exported.blob.size).toBeGreaterThan(0);

    const inspected = await backupService.inspect(exported.blob);
    expect(inspected.manifest.counts.trips).toBe(1);
    expect(inspected.integrity.ok).toBe(true);
    expect(Array.isArray(inspected.conflicts)).toBe(true);
  }, 20_000);
});
