import { beforeEach, describe, expect, it, vi } from 'vitest';
import { previewTrackCleanup } from '../src/core/gpsQuality';

const mocks = vi.hoisted(() => ({
  db: {
    trips: { get: vi.fn() }, trackChunks: {}, trackSnapshots: {}, segments: {},
    transaction: vi.fn()
  },
  loadTripTrack: vi.fn(), loadTrackSnapshot: vi.fn(), saveTrackSnapshotInTx: vi.fn(),
  saveTrackRepairVersionInTx: vi.fn(), loadTrackRepairVersion: vi.fn(),
  replaceSegmentPointsInTx: vi.fn(), updateTripInTx: vi.fn(), abortTransactionOnSignal: vi.fn(),
  pushAction: vi.fn(), emit: vi.fn(),
  previewTrackCleanupAsync: vi.fn(), previewTrackRepairAsync: vi.fn()
}));

vi.mock('../src/core/store', () => ({
  db: mocks.db,
  loadTripTrack: mocks.loadTripTrack,
  loadTrackSnapshot: mocks.loadTrackSnapshot,
  saveTrackSnapshotInTx: mocks.saveTrackSnapshotInTx,
  saveTrackRepairVersionInTx: mocks.saveTrackRepairVersionInTx,
  loadTrackRepairVersion: mocks.loadTrackRepairVersion,
  replaceSegmentPointsInTx: mocks.replaceSegmentPointsInTx,
  updateTripInTx: mocks.updateTripInTx,
  abortTransactionOnSignal: mocks.abortTransactionOnSignal
}));
vi.mock('../src/core/workerBridge', () => ({
  previewTrackCleanupAsync: mocks.previewTrackCleanupAsync,
  previewTrackRepairAsync: mocks.previewTrackRepairAsync
}));
vi.mock('../src/core/history', () => ({ pushAction: mocks.pushAction }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));

import { cleanGpsTrack, restoreGpsTrack, applyTrackRepair, restoreTrackRepairVersion } from '../src/core/trackCleanup';
import { buildTrackRepairPreview } from '../src/core/trackRepair';

const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
const originalPoints = [...forward, ...falseCluster, point(-450, 40_000)];
const cleanedPoints = [...forward, point(-450, 40_000)];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.abortTransactionOnSignal.mockImplementation((transaction: any, signal?: AbortSignal) => {
    if (!signal) return () => {};
    const abort = () => { if (transaction.active) transaction.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  });
  mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => {
    const transaction: any = { active: true, abort: vi.fn(() => { transaction.active = false; }) };
    return write(transaction);
  });
  mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 10 });
  mocks.loadTripTrack.mockResolvedValue({
    trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
    segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
  });
  mocks.previewTrackCleanupAsync.mockImplementation(async (segments, activity, opts) => previewTrackCleanup(segments, activity, opts));
  mocks.previewTrackRepairAsync.mockImplementation(async (segments, activity, opts) => buildTrackRepairPreview(segments, activity, opts));
  mocks.loadTrackSnapshot.mockResolvedValue([{ id: 'seg-1', index: 0, points: originalPoints }]);
  mocks.saveTrackSnapshotInTx.mockResolvedValue(true);
  mocks.saveTrackRepairVersionInTx.mockResolvedValue({ versionId: 'repair-v1', version: 1, createdAt: 20 });
  mocks.replaceSegmentPointsInTx.mockResolvedValue(undefined);
  mocks.updateTripInTx.mockResolvedValue(1);
});

describe('persistent GPS cleanup', () => {
  it('snapshots original points before replacing them and supports undo/redo', async () => {
    const result = await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });

    expect(result.removed).toBe(3);
    expect(mocks.saveTrackSnapshotInTx).toHaveBeenCalledWith('trip-1', expect.any(Array));
    expect(mocks.saveTrackSnapshotInTx.mock.invocationCallOrder[0]).toBeLessThan(mocks.replaceSegmentPointsInTx.mock.invocationCallOrder[0]);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', cleanedPoints);
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await action.undo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', originalPoints);
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 12 },
      segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
    });
    await action.redo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', cleanedPoints);
    expect(mocks.emit).toHaveBeenCalledWith('gps:changed', { tripId: 'trip-1' });
  });

  it('treats unchanged NaN metadata as the same original fix', async () => {
    const original = originalPoints.map((point, index) => index === 0 ? { ...point, alt: NaN } : point);
    const cleaned = cleanedPoints.map((point, index) => index === 0 ? { ...point, alt: NaN } : point);
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: original }]
    });

    await cleanGpsTrack('trip-1', {
      expectedUpdatedAt: 10,
      preview: previewTrackCleanup([{ id: 'seg-1', points: original }], 'drive')
    });

    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', cleaned);
  });

  it('rejects a stale preview before any writes', async () => {
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 9 })).rejects.toThrow('track-changed');
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('rechecks freshness inside the transaction', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 11 });
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('rechecks point identity even when the timestamp is unchanged', async () => {
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
    }).mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('detects changes to cleaning-relevant fix metadata', async () => {
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
    }).mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{
        id: 'seg-1', index: 0,
        points: originalPoints.map((point, index) => index === 0 ? { ...point, acc: 25 } : point)
      }]
    });
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('recomputes and validates the lightweight preview supplied by the caller', async () => {
    const preview = previewTrackCleanup([{ id: 'seg-1', points: originalPoints }], 'drive');
    await cleanGpsTrack('trip-1', { preview, expectedUpdatedAt: 10 });
    expect(mocks.previewTrackCleanupAsync).toHaveBeenCalledWith(
      [{ id: 'seg-1', index: 0, points: originalPoints }], 'drive', {}, { signal: undefined }
    );
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', cleanedPoints);
  });

  it('rejects altered or malformed previews before any writes', async () => {
    const altered = previewTrackCleanup([{
      id: 'seg-1', points: originalPoints.map((point, index) => index === 5 ? { ...point, lon: point.lon + 0.01 } : point)
    }], 'drive');
    await expect(cleanGpsTrack('trip-1', { preview: altered, expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    await expect(cleanGpsTrack('trip-1', { preview: { removed: 1 }, expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('does not start a write transaction for a pre-aborted cleanup', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(cleanGpsTrack('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
  });

  it('rolls back cleanup when a write hook cancels the operation', async () => {
    const controller = new AbortController();
    mocks.replaceSegmentPointsInTx.mockImplementation(async () => { controller.abort(); });

    await expect(cleanGpsTrack('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.saveTrackSnapshotInTx).toHaveBeenCalledTimes(1);
    expect(mocks.updateTripInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rolls back cleanup when cancellation is queued after the callback but before commit', async () => {
    const controller = new AbortController();
    mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => {
      const transaction: any = { active: true, abort: vi.fn(() => { transaction.active = false; }) };
      const result = await write(transaction);
      queueMicrotask(() => controller.abort());
      await Promise.resolve();
      if (!transaction.active) throw new DOMException('Aborted', 'AbortError');
      transaction.active = false;
      return result;
    });

    await expect(cleanGpsTrack('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(1);
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('refuses undo and redo after a newer track edit', async () => {
    await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPointsInTx.mock.calls.length;
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: [{
        id: 'seg-1', index: 0,
        points: cleanedPoints.map((point, index) => index === 0 ? { ...point, acc: 99 } : point)
      }]
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(writes);
  });

  it('never recreates a segment deleted after cleaning', async () => {
    await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPointsInTx.mock.calls.length;
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: []
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(writes);
  });
});

describe('classified repair versions', () => {
  const repairPoints: any[] = [
    point(0, 0), point(0, 0), { ...point(2, 5_000), alt: 240 }
  ];
  const repairedPoints = [point(0, 0), { lat: 30, lon: 120 + 2 / 95_600, t: 5_000, acc: 5 }];
  const repairFull = (points = repairPoints) => ({
    trip: { id: 'trip-1', activity: 'hike', updatedAt: 10 },
    segments: [{ id: 'seg-1', index: 0, points }]
  });

  it('applies selected categories, retains the raw snapshot and creates one repairable version', async () => {
    mocks.loadTripTrack.mockResolvedValue(repairFull());
    const preview = buildTrackRepairPreview(repairFull().segments, 'hike', { selected: ['duplicate-fix', 'altitude-jump'] });

    expect(preview.summary.altitudeCleared).toBe(1);
    const result = await applyTrackRepair('trip-1', { preview, expectedUpdatedAt: 10 });

    expect(result).toMatchObject({ removed: 1, altitudeCleared: 1, version: { versionId: 'repair-v1', version: 1 } });
    expect(mocks.saveTrackSnapshotInTx).toHaveBeenCalledWith('trip-1', expect.any(Array));
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', repairedPoints);
    expect(mocks.saveTrackRepairVersionInTx).toHaveBeenCalledWith('trip-1', [
      { id: 'seg-1', index: 0, points: repairedPoints }
    ], expect.objectContaining({
      sourceUpdatedAt: 10, previewId: preview.previewId,
      selectedCategories: ['altitude-jump', 'duplicate-fix'],
      summary: expect.objectContaining({ removed: 1, altitudeCleared: 1 })
    }));
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripTrack.mockResolvedValue(repairFull(repairedPoints));
    await action.undo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', repairPoints);
    mocks.loadTripTrack.mockResolvedValue(repairFull(repairPoints));
    await action.redo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', repairedPoints);
    expect(mocks.saveTrackRepairVersionInTx).toHaveBeenCalledTimes(1);
  });

  it('records classify-only selections without creating a raw restore snapshot or edit history', async () => {
    const gapPoints = [point(0, 0), point(0, 120_000)];
    mocks.loadTripTrack.mockResolvedValue(repairFull(gapPoints));
    const preview = buildTrackRepairPreview(repairFull(gapPoints).segments, 'hike', { selected: ['gap-pause'] });

    expect(preview.summary).toMatchObject({ removed: 0, altitudeCleared: 0, classifiedGaps: 1 });
    const result = await applyTrackRepair('trip-1', { preview, expectedUpdatedAt: 10 });

    expect(result).toMatchObject({ removed: 0, altitudeCleared: 0, version: { versionId: 'repair-v1', version: 1 } });
    expect(mocks.saveTrackSnapshotInTx).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.saveTrackRepairVersionInTx).toHaveBeenCalledWith('trip-1', repairFull(gapPoints).segments, expect.objectContaining({
      selectedCategories: ['gap-pause']
    }));
  });

  it('rejects a preview whose category selection changed before any write', async () => {
    mocks.loadTripTrack.mockResolvedValue(repairFull());
    const preview = buildTrackRepairPreview(repairFull().segments, 'hike');
    const altered = { ...preview, selected: ['invalid-time'] };

    await expect(applyTrackRepair('trip-1', { preview: altered, expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackRepairVersionInTx).not.toHaveBeenCalled();
  });

  it('does not publish history or a repair version when cancellation aborts the write', async () => {
    mocks.loadTripTrack.mockResolvedValue(repairFull());
    const preview = buildTrackRepairPreview(repairFull().segments, 'hike');
    const controller = new AbortController();
    mocks.replaceSegmentPointsInTx.mockImplementation(async () => { controller.abort(); });

    await expect(applyTrackRepair('trip-1', {
      preview, expectedUpdatedAt: 10, signal: controller.signal
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.saveTrackRepairVersionInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('restores a chosen version without touching segments added later and supports undo/redo', async () => {
    const added = { id: 'seg-2', index: 1, points: [point(3, 6_000)] };
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'hike', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: repairPoints }, added]
    });
    mocks.loadTrackRepairVersion.mockResolvedValue({
      versionId: 'repair-v1', version: 1, segments: [{ id: 'seg-1', index: 0, points: repairedPoints }]
    });

    const result = await restoreTrackRepairVersion('trip-1', 'repair-v1', { expectedUpdatedAt: 10 });

    expect(result.restored).toBe(2);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', repairedPoints);
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'hike', updatedAt: 11 },
      segments: [{ id: 'seg-1', index: 0, points: repairedPoints }, added]
    });
    await action.undo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', repairPoints);
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'hike', updatedAt: 12 },
      segments: [{ id: 'seg-1', index: 0, points: repairPoints }, added]
    });
    await action.redo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', repairedPoints);
  });
});

describe('GPS snapshot restoration', () => {
  it('restores original points without touching segments added after the snapshot', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    const addedPoint = point(-500, 45_000);
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [
        { id: 'seg-1', index: 0, points: cleanedPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });

    const result = await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });

    expect(result.restored).toBe(originalPoints.length);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledWith('seg-1', 'trip-1', originalPoints);
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [
        { id: 'seg-1', index: 0, points: originalPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });
    await action.undo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', cleanedPoints);
    mocks.loadTripTrack.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 22 },
      segments: [
        { id: 'seg-1', index: 0, points: cleanedPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });
    await action.redo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('seg-1', 'trip-1', originalPoints);
  });

  it('refuses history actions after restoration when the track changes', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPointsInTx.mock.calls.length;
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [{
        id: 'seg-1', index: 0,
        points: originalPoints.map((point, index) => index === 0 ? { ...point, acc: 99 } : point)
      }]
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(writes);
  });

  it('never recreates a segment deleted after restoration', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPointsInTx.mock.calls.length;
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: []
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(writes);
  });

  it('cancels restoration before publishing history or events', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    const controller = new AbortController();
    mocks.replaceSegmentPointsInTx.mockImplementation(async () => { controller.abort(); });

    await expect(restoreGpsTrack('trip-1', { expectedUpdatedAt: 20, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.updateTripInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rejects restoration when the snapshot changed after confirmation', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    mocks.loadTrackSnapshot
      .mockResolvedValueOnce([{ id: 'seg-1', index: 0, createdAt: 1, points: originalPoints }])
      .mockResolvedValueOnce([{ id: 'seg-1', index: 0, createdAt: 1, points: originalPoints.slice(1) }]);

    await expect(restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 })).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });

  it('rejects restoration when the track changed after confirmation', async () => {
    mocks.loadTripTrack.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await expect(restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 })).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
  });
});
