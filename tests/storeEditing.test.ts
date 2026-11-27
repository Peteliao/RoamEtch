import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSegment, appendPoints, createTrip, db, loadTripTrack, replaceSegmentPoints } from '../src/core/store';

const original = [
  { lat: 30, lon: 120, t: 1, acc: 5 },
  { lat: 30.001, lon: 120.001, t: 2, acc: 5 }
];

let tripId: string;
let segmentId: string;

beforeEach(async () => {
  await db.delete();
  await db.open();
  const trip = await createTrip({ activity: 'hike', status: 'finished' });
  tripId = trip.id;
  const segment = await addSegment(tripId, 1);
  segmentId = segment.id;
  await appendPoints(segmentId, tripId, original);
});

afterEach(async () => {
  db.close();
  await db.delete();
});

describe('compare-and-swap segment editing', () => {
  it('rejects a stale edit base without changing points or trip metadata', async () => {
    const tripBefore = await db.trips.get(tripId);
    const stale = [{ ...original[0], acc: 99 }, original[1]];
    const next = [{ ...original[0], lon: 121 }, original[1]];

    await expect(replaceSegmentPoints(segmentId, tripId, next, stale)).rejects.toThrow('track-changed');

    expect((await loadTripTrack(tripId))?.segments[0].points).toEqual(original);
    expect(await db.trips.get(tripId)).toEqual(tripBefore);
  });

  it('allows only one of two concurrent edits from the same base to commit', async () => {
    const first = [{ ...original[0], lon: 121 }, original[1]];
    const second = [{ ...original[0], lat: 31 }, original[1]];

    const results = await Promise.allSettled([
      replaceSegmentPoints(segmentId, tripId, first, original),
      replaceSegmentPoints(segmentId, tripId, second, original)
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const committed = results[0].status === 'fulfilled' ? first : second;
    expect((await loadTripTrack(tripId))?.segments[0].points).toEqual(committed);
  });
});
