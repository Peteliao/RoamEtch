import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const db: any = {
    trips: { get: vi.fn() }, trackChunks: {}, trackSnapshots: {}, segments: {},
    transaction: vi.fn()
  };
  return {
    db,
    loadTripFull: vi.fn(), loadTrackSnapshot: vi.fn(), saveTrackSnapshot: vi.fn(),
    replaceSegmentPoints: vi.fn(), updateTrip: vi.fn(), pushAction: vi.fn(), emit: vi.fn()
  };
});

vi.mock('../src/core/store', () => ({
  db: mocks.db,
  loadTripFull: mocks.loadTripFull,
  loadTrackSnapshot: mocks.loadTrackSnapshot,
  saveTrackSnapshot: mocks.saveTrackSnapshot,
  replaceSegmentPoints: mocks.replaceSegmentPoints,
  updateTrip: mocks.updateTrip
}));
vi.mock('../src/core/history', () => ({ pushAction: mocks.pushAction }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));

import { cleanGpsTrack, restoreGpsTrack } from '../src/core/trackCleanup';

const point = (lon, t) => ({ lat: 30, lon: 120 + lon / 95_600, t, acc: 5, alt: 100 });
const forward = [0, -100, -200, -300, -400].map((lon, i) => point(lon, i * 5_000));
const falseCluster = [-100, -200, -300].map((lon, i) => point(lon, (i + 5) * 5_000));
const originalPoints = [...forward, ...falseCluster, point(-450, 40_000)];
const cleanedPoints = [...forward, point(-450, 40_000)];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.transaction.mockImplementation(async (_mode, _tables, write) => write());
  mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 10 });
  mocks.loadTripFull.mockResolvedValue({
    trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
    segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
  });
  mocks.loadTrackSnapshot.mockResolvedValue([{ id: 'seg-1', index: 0, points: originalPoints }]);
  mocks.saveTrackSnapshot.mockResolvedValue(true);
  mocks.replaceSegmentPoints.mockResolvedValue(undefined);
  mocks.updateTrip.mockResolvedValue(1);
});

describe('persistent GPS cleanup', () => {
  it('snapshots original points before replacing them and supports undo/redo', async () => {
    const result = await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });

    expect(result.removed).toBe(3);
    expect(mocks.saveTrackSnapshot).toHaveBeenCalledWith('trip-1', expect.any(Array));
    expect(mocks.saveTrackSnapshot.mock.invocationCallOrder[0]).toBeLessThan(mocks.replaceSegmentPoints.mock.invocationCallOrder[0]);
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledWith('seg-1', 'trip-1', cleanedPoints);
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripFull.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await action.undo();
    expect(mocks.replaceSegmentPoints).toHaveBeenLastCalledWith('seg-1', 'trip-1', originalPoints);
    mocks.loadTripFull.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 12 },
      segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
    });
    await action.redo();
    expect(mocks.replaceSegmentPoints).toHaveBeenLastCalledWith('seg-1', 'trip-1', cleanedPoints);
    expect(mocks.emit).toHaveBeenCalledWith('gps:changed', { tripId: 'trip-1' });
  });

  it('treats unchanged NaN metadata as the same original fix', async () => {
    const original = originalPoints.map((point, index) => index === 0 ? { ...point, alt: NaN } : point);
    const cleaned = cleanedPoints.map((point, index) => index === 0 ? { ...point, alt: NaN } : point);
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: original }]
    });

    await cleanGpsTrack('trip-1', {
      expectedUpdatedAt: 10,
      preview: { removed: 3, segments: [{ id: 'seg-1', points: cleaned }] }
    });

    expect(mocks.replaceSegmentPoints).toHaveBeenCalledWith('seg-1', 'trip-1', cleaned);
  });

  it('rejects a stale preview before any writes', async () => {
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 9 })).rejects.toThrow('track-changed');
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackSnapshot).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('rechecks freshness inside the transaction', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 11 });
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.saveTrackSnapshot).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('rechecks point identity even when the timestamp is unchanged', async () => {
    mocks.loadTripFull.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: originalPoints }]
    }).mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 10 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await expect(cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 })).rejects.toThrow('track-changed');
    expect(mocks.saveTrackSnapshot).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('detects changes to cleaning-relevant fix metadata', async () => {
    mocks.loadTripFull.mockResolvedValueOnce({
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
    expect(mocks.saveTrackSnapshot).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('uses the exact preview supplied by the caller', async () => {
    const preview = {
      removed: 1, issues: [{ reason: 'speed', count: 1 }],
      segments: [{ id: 'seg-1', points: [forward[0]] }]
    };
    await cleanGpsTrack('trip-1', { preview, expectedUpdatedAt: 10 });
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledWith('seg-1', 'trip-1', [forward[0]]);
  });

  it('rejects previews that add or alter points before any writes', async () => {
    const preview = {
      removed: 1,
      segments: [{ id: 'seg-1', points: [{ ...forward[0], acc: 99 }] }]
    };
    await expect(cleanGpsTrack('trip-1', { preview, expectedUpdatedAt: 10 })).rejects.toThrow('invalid-preview');
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.saveTrackSnapshot).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('refuses undo and redo after a newer track edit', async () => {
    await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPoints.mock.calls.length;
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: [{
        id: 'seg-1', index: 0,
        points: cleanedPoints.map((point, index) => index === 0 ? { ...point, acc: 99 } : point)
      }]
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledTimes(writes);
  });

  it('never recreates a segment deleted after cleaning', async () => {
    await cleanGpsTrack('trip-1', { expectedUpdatedAt: 10 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPoints.mock.calls.length;
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 11 },
      segments: []
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledTimes(writes);
  });
});

describe('GPS snapshot restoration', () => {
  it('restores original points without touching segments added after the snapshot', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    const addedPoint = point(-500, 45_000);
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [
        { id: 'seg-1', index: 0, points: cleanedPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });

    const result = await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });

    expect(result.restored).toBe(originalPoints.length);
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledWith('seg-1', 'trip-1', originalPoints);
    const action = mocks.pushAction.mock.calls[0][0];
    mocks.loadTripFull.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [
        { id: 'seg-1', index: 0, points: originalPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });
    await action.undo();
    expect(mocks.replaceSegmentPoints).toHaveBeenLastCalledWith('seg-1', 'trip-1', cleanedPoints);
    mocks.loadTripFull.mockResolvedValueOnce({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 22 },
      segments: [
        { id: 'seg-1', index: 0, points: cleanedPoints },
        { id: 'seg-2', index: 1, points: [addedPoint] }
      ]
    });
    await action.redo();
    expect(mocks.replaceSegmentPoints).toHaveBeenLastCalledWith('seg-1', 'trip-1', originalPoints);
  });

  it('refuses history actions after restoration when the track changes', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPoints.mock.calls.length;
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [{
        id: 'seg-1', index: 0,
        points: originalPoints.map((point, index) => index === 0 ? { ...point, acc: 99 } : point)
      }]
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledTimes(writes);
  });

  it('never recreates a segment deleted after restoration', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 });
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPoints.mock.calls.length;
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: []
    });

    await expect(action.undo()).rejects.toThrow('track-changed');
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).toHaveBeenCalledTimes(writes);
  });

  it('rejects restoration when the snapshot changed after confirmation', async () => {
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 20 });
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 20 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    mocks.loadTrackSnapshot
      .mockResolvedValueOnce([{ id: 'seg-1', index: 0, createdAt: 1, points: originalPoints }])
      .mockResolvedValueOnce([{ id: 'seg-1', index: 0, createdAt: 1, points: originalPoints.slice(1) }]);

    await expect(restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 })).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });

  it('rejects restoration when the track changed after confirmation', async () => {
    mocks.loadTripFull.mockResolvedValue({
      trip: { id: 'trip-1', activity: 'drive', updatedAt: 21 },
      segments: [{ id: 'seg-1', index: 0, points: cleanedPoints }]
    });
    await expect(restoreGpsTrack('trip-1', { expectedUpdatedAt: 20 })).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPoints).not.toHaveBeenCalled();
  });
});
