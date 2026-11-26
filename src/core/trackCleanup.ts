import { buildTrackCleanupEdits, sameTrackCleanupPreview } from './gpsQuality';
import { previewTrackCleanupAsync } from './workerBridge';
import { pushAction } from './history';
import { emit } from './events';
import {
  db, loadTripTrack, loadTrackSnapshot, replaceSegmentPointsInTx,
  saveTrackSnapshotInTx, updateTripInTx, abortTransactionOnSignal
} from './store';

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Track cleanup aborted.', 'AbortError');
}

export async function cleanGpsTrack(tripId, { activity, preview = null, expectedUpdatedAt = null, signal }: any = {}) {
  throwIfAborted(signal);
  const full = await loadTripTrack(tripId);
  throwIfAborted(signal);
  if (!full) return { removed: 0, segments: 0 };
  if (expectedUpdatedAt != null && full.trip.updatedAt !== expectedUpdatedAt) throw new Error('track-changed');
  const resolvedActivity = activity || full.trip.activity || 'hike';
  const result = await previewTrackCleanupAsync(full.segments, resolvedActivity, {}, { signal });
  throwIfAborted(signal);
  if (preview && !sameTrackCleanupPreview(preview, result)) throw new Error('track-changed');
  const edits = buildTrackCleanupEdits(full.segments, result);
  const removed = edits.reduce((sum, edit) => sum + edit.before.length - edit.after.length, 0);
  if (!removed) return { removed: 0, segments: 0 };

  const write = async (useAfter, guard, operationSignal?: AbortSignal) => {
    throwIfAborted(operationSignal);
    let detachAbort: (() => void) | undefined;
    try {
      await db.transaction('rw', [db.trackChunks, db.trackSnapshots, db.segments, db.trips], async (transaction) => {
        detachAbort = abortTransactionOnSignal(transaction, operationSignal);
        throwIfAborted(operationSignal);
        const trip = await db.trips.get(tripId);
        throwIfAborted(operationSignal);
        if (!trip || (guard.expectedUpdatedAt != null && trip.updatedAt !== guard.expectedUpdatedAt)) throw new Error('track-changed');
        if (!trackMatches(await loadTripTrack(tripId), guard.segments, guard.allowAdditional)) throw new Error('track-changed');
        throwIfAborted(operationSignal);
        if (useAfter) await saveTrackSnapshotInTx(tripId, full.segments);
        for (const edit of edits) {
          throwIfAborted(operationSignal);
          await replaceSegmentPointsInTx(edit.segmentId, tripId, useAfter ? edit.after : edit.before);
        }
        throwIfAborted(operationSignal);
        await updateTripInTx(tripId, { statsCache: null, thumbPoints: null, reportedDistance: null });
        throwIfAborted(operationSignal);
      });
    } finally {
      detachAbort?.();
    }
  };

  await write(true, { segments: full.segments, expectedUpdatedAt, allowAdditional: false }, signal);
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

export async function restoreGpsTrack(tripId, { expectedUpdatedAt = null, signal }: any = {}) {
  throwIfAborted(signal);
  const [full, snapshot] = await Promise.all([loadTripTrack(tripId), loadTrackSnapshot(tripId)]);
  throwIfAborted(signal);
  if (!full || !snapshot.length) return { restored: 0 };
  if (expectedUpdatedAt != null && full.trip.updatedAt !== expectedUpdatedAt) throw new Error('track-changed');
  const original = new Map(snapshot.map((segment) => [segment.id, segment.points]));
  const edits = full.segments.filter((segment) => original.has(segment.id)).map((segment) => ({
    segmentId: segment.id,
    before: segment.points.map((point) => ({ ...point })),
    after: original.get(segment.id).map((point) => ({ ...point }))
  })).filter((edit) => !samePoints(edit.before, edit.after));

  const write = async (useOriginal, guard, operationSignal?: AbortSignal) => {
    throwIfAborted(operationSignal);
    let detachAbort: (() => void) | undefined;
    try {
      await db.transaction('rw', [db.trackChunks, db.trackSnapshots, db.segments, db.trips], async (transaction) => {
        detachAbort = abortTransactionOnSignal(transaction, operationSignal);
        throwIfAborted(operationSignal);
        const trip = await db.trips.get(tripId);
        throwIfAborted(operationSignal);
        if (!trip || (guard.expectedUpdatedAt != null && trip.updatedAt !== guard.expectedUpdatedAt)) throw new Error('track-changed');
        if (!trackMatches(await loadTripTrack(tripId), guard.segments, guard.allowAdditional)) throw new Error('track-changed');
        if (!sameSnapshots(snapshot, await loadTrackSnapshot(tripId))) throw new Error('track-changed');
        throwIfAborted(operationSignal);
        for (const edit of edits) {
          throwIfAborted(operationSignal);
          await replaceSegmentPointsInTx(edit.segmentId, tripId, useOriginal ? edit.after : edit.before);
        }
        throwIfAborted(operationSignal);
        await updateTripInTx(tripId, {
          statsCache: null, thumbPoints: null, reportedDistance: null,
          ...(useOriginal ? { gpsRestoredAt: Date.now() } : {})
        });
        throwIfAborted(operationSignal);
      });
    } finally {
      detachAbort?.();
    }
  };

  if (!edits.length) return { restored: 0 };
  await write(true, { segments: full.segments, expectedUpdatedAt, allowAdditional: false }, signal);
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
