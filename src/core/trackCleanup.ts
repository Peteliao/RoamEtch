import { cleanTrackSegments } from './gpsQuality';
import { pushAction } from './history';
import { emit } from './events';
import {
  db, loadTripFull, loadTrackSnapshot, replaceSegmentPoints,
  saveTrackSnapshot, updateTrip
} from './store';

export async function cleanGpsTrack(tripId, { activity, preview = null, expectedUpdatedAt = null }: any = {}) {
  const full = await loadTripFull(tripId);
  if (!full) return { removed: 0, segments: 0 };
  if (expectedUpdatedAt != null && full.trip.updatedAt !== expectedUpdatedAt) throw new Error('track-changed');
  const result = preview || cleanTrackSegments(full.segments, activity || full.trip.activity || 'hike');
  if (!Array.isArray(result.segments) || result.segments.length !== full.segments.length) throw new Error('invalid-preview');

  const edits = full.segments.map((seg, index) => {
    const after = result.segments[index]?.points;
    if (!Array.isArray(after) || !isSubsequence(seg.points, after)) throw new Error('invalid-preview');
    return {
      segmentId: seg.id,
      before: seg.points.map((point) => ({ ...point })),
      after: after.map((point) => ({ ...point }))
    };
  }).filter((edit) => !samePoints(edit.before, edit.after));
  const removed = edits.reduce((sum, edit) => sum + edit.before.length - edit.after.length, 0);
  if (!removed) return { removed: 0, segments: 0 };

  const write = async (useAfter, guard) => db.transaction('rw', [db.trackChunks, db.trackSnapshots, db.segments, db.trips, db.waypoints, db.media], async () => {
    const trip = await db.trips.get(tripId);
    if (!trip || (guard.expectedUpdatedAt != null && trip.updatedAt !== guard.expectedUpdatedAt)) throw new Error('track-changed');
    if (!trackMatches(await loadTripFull(tripId), guard.segments, guard.allowAdditional)) throw new Error('track-changed');
    if (useAfter) await saveTrackSnapshot(tripId, full.segments);
    for (const edit of edits) await replaceSegmentPoints(edit.segmentId, tripId, useAfter ? edit.after : edit.before);
    await updateTrip(tripId, { statsCache: null, thumbPoints: null });
  });

  await write(true, { segments: full.segments, expectedUpdatedAt, allowAdditional: false });
  pushAction({
    label: 'gps-clean',
    undo: async () => {
      await write(false, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.after })), allowAdditional: true });
      emit('gps:changed', { tripId });
    },
    redo: async () => {
      await write(true, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.before })), allowAdditional: true });
      emit('gps:changed', { tripId });
    }
  });
  emit('gps:changed', { tripId });
  return { removed, segments: edits.length, issues: result.issues };
}

function trackMatches(current, expectedSegments, allowAdditional) {
  if (!current || !Array.isArray(current.segments)) return false;
  if (!allowAdditional && current.segments.length !== expectedSegments.length) return false;
  const byId = new Map(current.segments.map((segment) => [segment.id, segment]));
  return expectedSegments.every((segment, index) => {
    const actual = allowAdditional ? byId.get(segment.id) : current.segments[index];
    return actual?.id === segment.id && samePoints(actual.points, segment.points);
  });
}

function samePoints(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i], right = b[i];
    const leftKeys = Object.keys(left), rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key) => !Object.prototype.hasOwnProperty.call(right, key) || !Object.is(left[key], right[key]))) return false;
  }
  return true;
}

function sameSnapshots(a, b) {
  return a.length === b.length && a.every((segment, index) => {
    const other = b[index];
    return segment.id === other.id && segment.index === other.index
      && segment.createdAt === other.createdAt && samePoints(segment.points, other.points);
  });
}

function isSubsequence(before, after) {
  let cursor = 0;
  for (const point of after) {
    while (cursor < before.length && !samePoints([before[cursor]], [point])) cursor++;
    if (cursor === before.length) return false;
    cursor++;
  }
  return true;
}

export async function restoreGpsTrack(tripId, { expectedUpdatedAt = null } = {}) {
  const [full, snapshot] = await Promise.all([loadTripFull(tripId), loadTrackSnapshot(tripId)]);
  if (!full || !snapshot.length) return { restored: 0 };
  if (expectedUpdatedAt != null && full.trip.updatedAt !== expectedUpdatedAt) throw new Error('track-changed');
  const original = new Map(snapshot.map((segment) => [segment.id, segment.points]));
  const edits = full.segments.filter((segment) => original.has(segment.id)).map((segment) => ({
    segmentId: segment.id,
    before: segment.points.map((point) => ({ ...point })),
    after: original.get(segment.id).map((point) => ({ ...point }))
  })).filter((edit) => !samePoints(edit.before, edit.after));

  const write = async (useOriginal, guard) => db.transaction('rw', [db.trackChunks, db.trackSnapshots, db.segments, db.trips, db.waypoints, db.media], async () => {
    const trip = await db.trips.get(tripId);
    if (!trip || (guard.expectedUpdatedAt != null && trip.updatedAt !== guard.expectedUpdatedAt)) throw new Error('track-changed');
    if (!trackMatches(await loadTripFull(tripId), guard.segments, guard.allowAdditional)) throw new Error('track-changed');
    if (!sameSnapshots(snapshot, await loadTrackSnapshot(tripId))) throw new Error('track-changed');
    for (const edit of edits) await replaceSegmentPoints(edit.segmentId, tripId, useOriginal ? edit.after : edit.before);
    await updateTrip(tripId, {
      statsCache: null, thumbPoints: null,
      ...(useOriginal ? { gpsRestoredAt: Date.now() } : {})
    });
  });

  if (!edits.length) return { restored: 0 };
  await write(true, { segments: full.segments, expectedUpdatedAt, allowAdditional: false });
  pushAction({
    label: 'gps-restore',
    undo: async () => {
      await write(false, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.after })), allowAdditional: true });
      emit('gps:changed', { tripId });
    },
    redo: async () => {
      await write(true, { segments: edits.map((edit) => ({ id: edit.segmentId, points: edit.before })), allowAdditional: true });
      emit('gps:changed', { tripId });
    }
  });
  emit('gps:changed', { tripId });
  return { restored: edits.reduce((sum, edit) => sum + edit.after.length, 0) };
}
