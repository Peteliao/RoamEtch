import { cleanTrackSegments } from './gpsQuality';
import { pushAction } from './history';
import { emit } from './events';
import { db, loadTripFull, replaceSegmentPoints, updateTrip } from './store';

export async function cleanGpsTrack(tripId, { activity }: { activity?: string } = {}) {
  const full = await loadTripFull(tripId);
  if (!full) return { removed: 0, segments: 0 };
  const result = cleanTrackSegments(full.segments, activity || full.trip.activity || 'hike');
  if (!result.removed) return { removed: 0, segments: 0 };

  const edits = full.segments.map((seg, index) => ({
    segmentId: seg.id,
    before: seg.points.map((point) => ({ ...point })),
    after: result.segments[index].points.map((point) => ({ ...point }))
  })).filter((edit) => edit.before.length !== edit.after.length);

  const write = async (useAfter) => db.transaction('rw', [db.trackChunks, db.segments, db.trips], async () => {
    for (const edit of edits) await replaceSegmentPoints(edit.segmentId, tripId, useAfter ? edit.after : edit.before);
    await updateTrip(tripId, { statsCache: null });
  });

  await write(true);
  pushAction({
    label: 'gps-clean',
    undo: async () => { await write(false); emit('gps:changed', { tripId }); },
    redo: async () => { await write(true); emit('gps:changed', { tripId }); }
  });
  emit('gps:changed', { tripId });
  return { removed: result.removed, segments: edits.length };
}
