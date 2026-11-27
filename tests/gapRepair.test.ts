import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyPrivacy } from '../src/core/privacy';
import { bridgeTrackGapsForExport, repairTrackGaps, routeOverRoads } from '../src/core/gapRepair';

const mocks = vi.hoisted(() => ({
  db: { trips: { get: vi.fn() }, trackChunks: {}, trackSnapshots: {}, segments: {}, transaction: vi.fn() },
  loadTripTrack: vi.fn(), replaceSegmentPointsInTx: vi.fn(), updateTripInTx: vi.fn(),
  abortTransactionOnSignal: vi.fn(), commitTrackEdits: vi.fn(), pushAction: vi.fn(), emit: vi.fn()
  , loadTrackSnapshot: vi.fn(), saveTrackSnapshotInTx: vi.fn(), saveTrackRepairVersionInTx: vi.fn()
}));

vi.mock('../src/core/store', () => ({
  db: mocks.db,
  loadTripTrack: mocks.loadTripTrack,
  replaceSegmentPointsInTx: mocks.replaceSegmentPointsInTx,
  updateTripInTx: mocks.updateTripInTx,
  abortTransactionOnSignal: mocks.abortTransactionOnSignal,
  commitTrackEdits: mocks.commitTrackEdits,
  loadTrackSnapshot: mocks.loadTrackSnapshot,
  saveTrackSnapshotInTx: mocks.saveTrackSnapshotInTx,
  saveTrackRepairVersionInTx: mocks.saveTrackRepairVersionInTx
}));
vi.mock('../src/core/history', () => ({ pushAction: mocks.pushAction }));
vi.mock('../src/core/events', () => ({ emit: mocks.emit }));

function trip(segments: any[]) {
  return { trip: { id: 'trip-1', activity: 'hike', updatedAt: 10 }, segments, waypoints: [] };
}

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
  mocks.replaceSegmentPointsInTx.mockResolvedValue(undefined);
  mocks.updateTripInTx.mockResolvedValue(1);
  mocks.loadTrackSnapshot.mockResolvedValue([]);
  mocks.saveTrackSnapshotInTx.mockResolvedValue(true);
  mocks.saveTrackRepairVersionInTx.mockResolvedValue(null);
  mocks.commitTrackEdits.mockImplementation(async (tripId: string, options: any) => {
    const {
      edits, useAfter, signal, expectedUpdatedAt = null, verify, verifySnapshot,
      saveSnapshot = false, snapshotSegments = null, tripPatch = {}, persistVersion = null
    } = options || {};
    const throwIfAborted = () => {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    };
    let detachAbort: (() => void) | undefined;
    throwIfAborted();
    try {
      return await mocks.db.transaction('rw',
        [mocks.db.trackChunks, mocks.db.trackSnapshots, mocks.db.segments, mocks.db.trips], async (transaction: any) => {
          detachAbort = mocks.abortTransactionOnSignal(transaction, signal);
          throwIfAborted();
          const trip = await mocks.db.trips.get(tripId);
          if (!trip || (expectedUpdatedAt != null && trip.updatedAt !== expectedUpdatedAt)) throw new Error('track-changed');
          const current = await mocks.loadTripTrack(tripId, null, { cooperative: false });
          if (verify && !await verify(current)) throw new Error('track-changed');
          if (verifySnapshot && !verifySnapshot(await mocks.loadTrackSnapshot(tripId))) throw new Error('track-changed');
          throwIfAborted();
          if (saveSnapshot) await mocks.saveTrackSnapshotInTx(tripId, snapshotSegments || current?.segments || []);
          for (const edit of edits || []) {
            throwIfAborted();
            await mocks.replaceSegmentPointsInTx(edit.segmentId, tripId, useAfter ? edit.after : edit.before);
          }
          throwIfAborted();
          await mocks.updateTripInTx(tripId, { statsCache: null, thumbPoints: null, reportedDistance: null, ...tripPatch });
          throwIfAborted();
          if (persistVersion && useAfter) {
            return mocks.saveTrackRepairVersionInTx(tripId, persistVersion.segments, persistVersion.metadata);
          }
          return null;
        });
    } finally {
      detachAbort?.();
    }
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('read-only export gap bridging', () => {
  it('does not contact a fallback router after cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(routeOverRoads(
      { lat: 0, lon: 0 }, { lat: 0, lon: 0.002 }, 'hike', controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects cancellation that arrives while a successful response is decoded', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { features: [{ geometry: { coordinates: [[0.001, 0], [0.002, 0]] } }] };
      }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(routeOverRoads(
      { lat: 0, lon: 0 }, { lat: 0, lon: 0.002 }, 'hike', controller.signal
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes a real segment break without mutating the saved track', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ features: [{ geometry: { coordinates: [[0.0011, 0], [0.0019, 0]] } }] })
      };
    }));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.002, t: 120_000 }, { lat: 0, lon: 0.003, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 0 }), { radius: 0 });
    expect(requests).toHaveLength(1);
    expect(result.bridged).toBe(1);
    expect(result.points).toBeGreaterThan(0);
    expect(result.segments[0].points.some((p) => p.synth)).toBe(true);
    expect(full.segments[0].points).toHaveLength(2);
    expect(result.segments[0].points.at(-1).lat).toBe(0);
    expect(result.segments[0].points.at(-1).lon).toBeCloseTo(0.002);
  });

  it('removes synthesized route points that enter a privacy circle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ features: [{ geometry: { coordinates: [[0.0001, 0], [0.005, 0.001], [0.0079, 0]] } }] })
    })));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0.001, t: 0 }, { lat: 0, lon: 0.0038, t: 30_000 }, { lat: 0, lon: 0.004, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.008, t: 120_000 }, { lat: 0, lon: 0.0085, t: 150_000 }, { lat: 0, lon: 0.012, t: 180_000 }] }
    ]);
    const cropped = applyPrivacy(full, { radius: 300 });
    expect(cropped.segments).toHaveLength(2);
    const result = await bridgeTrackGapsForExport(full, cropped, { radius: 300 });
    expect(result.bridged).toBe(1);
    const synthetic = result.segments.flatMap((seg) => seg.points).filter((p) => p.synth);
    expect(synthetic.length).toBeGreaterThan(0);
    expect(synthetic.some((p) => p.lon === 0.0001)).toBe(false);
  });

  it('never sends a privacy-hidden endpoint to an external router', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.0025, t: 30_000 }, { lat: 0, lon: 0.003, t: 60_000 }, { lat: 0, lon: 0.0035, t: 90_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.007, t: 120_000 }, { lat: 0, lon: 0.0071, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 300 }), { radius: 300 });
    expect(result.bridged).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original gap when routing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.002, t: 120_000 }, { lat: 0, lon: 0.003, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 0 }), { radius: 0 });
    expect(result.bridged).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.segments[0].points).toHaveLength(2);
  });
});

function gappedTrack() {
  return trip([
    { id: 'a', index: 0, points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 60_000 }] },
    { id: 'b', index: 1, points: [{ lat: 0, lon: 0.002, t: 120_000 }, { lat: 0, lon: 0.003, t: 180_000 }] },
    { id: 'c', index: 2, points: [{ lat: 0, lon: 0.004, t: 240_000 }, { lat: 0, lon: 0.005, t: 300_000 }] }
  ]);
}

function routeSuccess() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const [from, to] = String(url).match(/lonlats=([^&]+)/)![1].split('|').map((pair) => pair.split(',').map(Number));
    return {
      ok: true,
      json: async () => ({ features: [{ geometry: { coordinates: [[(from[0] * 2 + to[0]) / 3, 0], [(from[0] + to[0] * 2) / 3, 0]] } }] })
    };
  }));
}

describe('persistent gap repair', () => {
  it('commits every repaired segment in one transaction and supports guarded undo/redo', async () => {
    routeSuccess();
    const full = gappedTrack();
    mocks.loadTripTrack.mockResolvedValue(full);

    const result = await repairTrackGaps('trip-1');

    expect(result).toMatchObject({ repaired: 2, failed: 0 });
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(2);
    expect(mocks.pushAction).toHaveBeenCalledTimes(1);
    const after = new Map(mocks.replaceSegmentPointsInTx.mock.calls.map(([segmentId, , points]) => [segmentId, points]));
    const action = mocks.pushAction.mock.calls[0][0];

    mocks.loadTripTrack.mockResolvedValue({
      ...full,
      segments: full.segments.map((segment) => ({ ...segment, points: after.get(segment.id) || segment.points }))
    });
    await action.undo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('b', 'trip-1', full.segments[1].points);

    mocks.loadTripTrack.mockResolvedValue(full);
    await action.redo();
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenLastCalledWith('b', 'trip-1', after.get('b'));
    expect(mocks.emit).toHaveBeenCalledWith('gap:changed', { tripId: 'trip-1' });
  });

  it('does not register history when any segment write fails', async () => {
    routeSuccess();
    mocks.loadTripTrack.mockResolvedValue(gappedTrack());
    mocks.replaceSegmentPointsInTx.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('write failed'));

    await expect(repairTrackGaps('trip-1')).rejects.toThrow('write failed');
    expect(mocks.db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('does not write when the final progress callback cancels the repair', async () => {
    routeSuccess();
    const full = trip(gappedTrack().segments.slice(0, 2));
    mocks.loadTripTrack.mockResolvedValue(full);
    const controller = new AbortController();

    await expect(repairTrackGaps('trip-1', {
      signal: controller.signal,
      onProgress: ({ done, total }) => {
        if (done === total) controller.abort();
      }
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.db.transaction).not.toHaveBeenCalled();
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
  });

  it('rolls back when cancellation arrives during the guarded transaction', async () => {
    routeSuccess();
    mocks.loadTripTrack.mockResolvedValue(trip(gappedTrack().segments.slice(0, 2)));
    const controller = new AbortController();
    mocks.db.trips.get.mockImplementation(async () => {
      controller.abort();
      return { id: 'trip-1', updatedAt: 10 };
    });

    await expect(repairTrackGaps('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
    expect(mocks.updateTripInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
  });

  it('rolls back when cancellation arrives during the final trip update', async () => {
    routeSuccess();
    mocks.loadTripTrack.mockResolvedValue(trip(gappedTrack().segments.slice(0, 2)));
    const controller = new AbortController();
    mocks.updateTripInTx.mockImplementation(async () => {
      controller.abort();
      return 1;
    });

    await expect(repairTrackGaps('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.updateTripInTx).toHaveBeenCalledTimes(1);
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rolls back when cancellation is queued after the transaction callback but before commit', async () => {
    routeSuccess();
    mocks.loadTripTrack.mockResolvedValue(trip(gappedTrack().segments.slice(0, 2)));
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

    await expect(repairTrackGaps('trip-1', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(1);
    expect(mocks.pushAction).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('rejects a stale trip revision before writing', async () => {
    routeSuccess();
    mocks.loadTripTrack.mockResolvedValue(gappedTrack());
    mocks.db.trips.get.mockResolvedValue({ id: 'trip-1', updatedAt: 11 });

    await expect(repairTrackGaps('trip-1')).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
  });

  it('rechecks point identity inside the transaction', async () => {
    routeSuccess();
    const full = gappedTrack();
    mocks.loadTripTrack.mockResolvedValueOnce(full).mockResolvedValueOnce({
      ...full,
      segments: full.segments.map((segment, index) => index === 1
        ? { ...segment, points: segment.points.map((point) => ({ ...point, acc: 99 })) }
        : segment)
    });

    await expect(repairTrackGaps('trip-1')).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).not.toHaveBeenCalled();
    expect(mocks.pushAction).not.toHaveBeenCalled();
  });

  it('refuses undo and redo after a target segment changes or disappears', async () => {
    routeSuccess();
    const full = gappedTrack();
    mocks.loadTripTrack.mockResolvedValue(full);
    await repairTrackGaps('trip-1');
    const action = mocks.pushAction.mock.calls[0][0];
    const writes = mocks.replaceSegmentPointsInTx.mock.calls.length;
    const after = new Map(mocks.replaceSegmentPointsInTx.mock.calls.map(([segmentId, , points]) => [segmentId, points]));

    mocks.loadTripTrack.mockResolvedValue({
      ...full,
      segments: full.segments.map((segment) => ({
        ...segment,
        points: (after.get(segment.id) || segment.points).map((point) => ({ ...point, acc: 99 }))
      }))
    });
    await expect(action.undo()).rejects.toThrow('track-changed');
    mocks.loadTripTrack.mockResolvedValue({ ...full, segments: full.segments.filter((segment) => segment.id !== 'b') });
    await expect(action.redo()).rejects.toThrow('track-changed');
    expect(mocks.replaceSegmentPointsInTx).toHaveBeenCalledTimes(writes);
  });
});
