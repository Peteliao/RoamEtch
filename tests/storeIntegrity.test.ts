import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: Record<string, any[]> = { trips: [], segments: [], trackChunks: [], trackSnapshots: [], quarantine: [] };
  let failSnapshotDelete = false;
  const makeTable = (name: string) => ({
    toArray: vi.fn(async () => state[name]),
    each: vi.fn(async (visit) => { for (const row of state[name]) visit(row); }),
    get: vi.fn(async (id: string) => state[name].find((row) => row.id === id)),
    bulkGet: vi.fn(async (ids: string[]) => ids.map((id) => state[name].find((row) => row.id === id))),
    bulkAdd: vi.fn(async (rows: any[]) => { state[name].push(...rows); }),
    put: vi.fn(async (row: any) => {
      const index = state[name].findIndex((entry) => entry.id === row.id);
      if (index >= 0) state[name][index] = row;
      else state[name].push(row);
    }),
    delete: vi.fn(async (id: string) => { state[name] = state[name].filter((row) => row.id !== id); }),
    orderBy: vi.fn(() => ({ reverse: () => ({ toArray: async () => [...state[name]].reverse() }) })),
    bulkDelete: vi.fn(async (ids: string[]) => {
      if (name === 'trackSnapshots' && failSnapshotDelete) throw new Error('delete failed');
      const removed = new Set(ids);
      state[name] = state[name].filter((row) => !removed.has(row.id));
    })
  });
  const db: any = {
    trips: makeTable('trips'), segments: makeTable('segments'),
    trackChunks: makeTable('trackChunks'), trackSnapshots: makeTable('trackSnapshots'), quarantine: makeTable('quarantine'),
    version: vi.fn(), stores: vi.fn(), upgrade: vi.fn(), on: vi.fn(), transaction: vi.fn()
  };
  db.version.mockReturnValue(db);
  db.stores.mockReturnValue(db);
  db.upgrade.mockReturnValue(db);
  db.transaction.mockImplementation(async (_mode, _tables, write) => {
    const snapshot = Object.fromEntries(Object.entries(state).map(([name, rows]) => [name, [...rows]]));
    try { return await write(); } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  });
  return {
    db, state,
    reset: () => {
      for (const name of Object.keys(state)) state[name] = [];
      failSnapshotDelete = false;
      vi.clearAllMocks();
      db.version.mockReturnValue(db);
      db.stores.mockReturnValue(db);
      db.upgrade.mockReturnValue(db);
    },
    failSnapshotDelete: () => { failSnapshotDelete = true; }
  };
});

vi.mock('dexie', () => ({ default: class MockDexie { constructor() { return mocks.db; } } }));

import { abortTransactionOnSignal, isolateDamaged, listQuarantinedRows, previewDamagedIsolation, restoreQuarantinedRows } from '../src/core/store';

beforeEach(() => mocks.reset());

describe('transaction cancellation binding', () => {
  it('aborts an active transaction and detaches the signal listener', () => {
    const controller = new AbortController();
    const transaction: any = { active: true, abort: vi.fn(() => { transaction.active = false; }) };
    const detach = abortTransactionOnSignal(transaction, controller.signal);

    controller.abort();
    detach();
    controller.abort();

    expect(transaction.abort).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately when the signal is already cancelled', () => {
    const controller = new AbortController();
    controller.abort();
    const transaction: any = { active: true, abort: vi.fn() };

    abortTransactionOnSignal(transaction, controller.signal);

    expect(transaction.abort).toHaveBeenCalledTimes(1);
  });

  it('does not turn an already committed transaction into a cancellation failure', () => {
    const controller = new AbortController();
    const transaction: any = { active: false, abort: vi.fn() };
    abortTransactionOnSignal(transaction, controller.signal);

    expect(() => controller.abort()).not.toThrow();
    expect(transaction.abort).not.toHaveBeenCalled();
  });

  it('treats a transaction abort rejected after commit as commit-wins', () => {
    const controller = new AbortController();
    const transaction: any = {
      active: true,
      abort: vi.fn(() => { throw new DOMException('Already committed', 'InvalidStateError'); })
    };
    abortTransactionOnSignal(transaction, controller.signal);

    expect(() => controller.abort()).not.toThrow();
    expect(transaction.abort).toHaveBeenCalledTimes(1);
  });
});

describe('damaged track isolation', () => {
  it('removes orphan segments and their dependent chunks and snapshots atomically', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push(
      { id: 'valid', tripId: 'trip-1', index: 0 },
      { id: 'orphan', tripId: 'missing', index: 0 }
    );
    mocks.state.trackChunks.push(
      { id: 'valid-chunk', tripId: 'trip-1', segmentId: 'valid', seq: 0, points: [] },
      { id: 'orphan-chunk', tripId: 'missing', segmentId: 'orphan', seq: 0, points: [] }
    );
    mocks.state.trackSnapshots.push(
      { id: 'valid-snapshot', tripId: 'trip-1', segmentId: 'valid', segmentIndex: 0, seq: 0, createdAt: 1, points: [] },
      { id: 'orphan-snapshot', tripId: 'missing', segmentId: 'orphan', segmentIndex: 0, seq: 0, createdAt: 1, points: [] }
    );

    await expect(isolateDamaged()).resolves.toBe(3);

    expect(mocks.state.segments.map((row) => row.id)).toEqual(['valid']);
    expect(mocks.state.trackChunks.map((row) => row.id)).toEqual(['valid-chunk']);
    expect(mocks.state.trackSnapshots.map((row) => row.id)).toEqual(['valid-snapshot']);
    expect(mocks.state.quarantine.map((row) => row.rowId).sort()).toEqual(['orphan', 'orphan-chunk', 'orphan-snapshot']);
    expect(new Set(mocks.state.quarantine.map((row) => row.batchId)).size).toBe(1);
    expect(mocks.db.transaction).toHaveBeenCalledWith('rw', expect.any(Array), expect.any(Function));
  });

  it('rolls back every isolation delete when a later delete fails', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'orphan', tripId: 'missing', index: 0 });
    mocks.state.trackChunks.push({ id: 'orphan-chunk', tripId: 'missing', segmentId: 'orphan', seq: 0, points: [] });
    mocks.state.trackSnapshots.push({ id: 'orphan-snapshot', tripId: 'missing', segmentId: 'orphan', segmentIndex: 0, seq: 0, createdAt: 1, points: [] });
    mocks.failSnapshotDelete();

    await expect(isolateDamaged()).rejects.toThrow('delete failed');

    expect(mocks.state.segments).toHaveLength(1);
    expect(mocks.state.trackChunks).toHaveLength(1);
    expect(mocks.state.trackSnapshots).toHaveLength(1);
    expect(mocks.state.quarantine).toHaveLength(0);
  });

  it('previews damage without writing and safely skips invalid quarantined points', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'bad', tripId: 'trip-1', index: 0 });
    mocks.state.trackChunks.push({
      id: 'bad-chunk', tripId: 'trip-1', segmentId: 'bad', seq: 0,
      points: [{ lat: 91, lon: 120, t: 1 }]
    });
    const preview = await previewDamagedIsolation();
    expect(preview).toMatchObject({ segments: 0, trackChunks: 1, trackSnapshots: 0, count: 1 });
    expect(mocks.state.quarantine).toHaveLength(0);
    expect(mocks.state.trackChunks).toHaveLength(1);

    await expect(isolateDamaged()).resolves.toBe(1);
    const quarantined = await listQuarantinedRows();
    expect(quarantined[0].reason).toBe('invalid-track-point');
    await expect(restoreQuarantinedRows()).resolves.toEqual({ restored: 0, skipped: 1 });
    expect(mocks.state.trackChunks).toHaveLength(0);
    expect(mocks.state.quarantine).toHaveLength(1);
  });

  it('isolates duplicate and noncontiguous chunk sequences and restores a complete set together', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'segment-1', tripId: 'trip-1', index: 0 });
    mocks.state.trackChunks.push(
      { id: 'chunk-0', tripId: 'trip-1', segmentId: 'segment-1', seq: 0, points: [] },
      { id: 'chunk-1', tripId: 'trip-1', segmentId: 'segment-1', seq: 1, points: [] },
      { id: 'chunk-3', tripId: 'trip-1', segmentId: 'segment-1', seq: 3, points: [] }
    );
    await expect(previewDamagedIsolation()).resolves.toMatchObject({ trackChunks: 3, count: 3 });
    await isolateDamaged();
    const records = await listQuarantinedRows();
    await expect(restoreQuarantinedRows([records.find((entry) => entry.row.seq === 3)!.id]))
      .resolves.toEqual({ restored: 0, skipped: 1 });
    await expect(restoreQuarantinedRows(records.filter((entry) => entry.row.seq < 2).map((entry) => entry.id)))
      .resolves.toEqual({ restored: 2, skipped: 0 });
    expect(mocks.state.trackChunks.map((row) => row.seq).sort()).toEqual([0, 1]);
    expect(mocks.state.quarantine).toHaveLength(1);
  });

  it('isolates every row of a repair version with inconsistent metadata', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'segment-1', tripId: 'trip-1', index: 0 });
    const base = {
      tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0, createdAt: 1,
      snapshotId: 'repair-1', kind: 'repair', repairVersion: 1, sourceUpdatedAt: 1,
      previewId: 'preview-1', sourceFingerprint: 'source-1', selectedCategories: [],
      summary: {}, metrics: {}, semantics: {}
    };
    mocks.state.trackSnapshots.push(
      { ...base, id: 'repair-0', seq: 0, points: [] },
      { ...base, id: 'repair-1', seq: 1, points: [], metrics: { points: 1 } }
    );
    await expect(previewDamagedIsolation()).resolves.toMatchObject({ trackSnapshots: 2, count: 2 });
    await isolateDamaged();
    await expect(restoreQuarantinedRows()).resolves.toEqual({ restored: 0, skipped: 2 });
    expect(mocks.state.trackSnapshots).toHaveLength(0);
    expect(mocks.state.quarantine).toHaveLength(2);
  });

  it('rejects snapshots whose segment index no longer matches the parent', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'segment-1', tripId: 'trip-1', index: 1 });
    mocks.state.trackSnapshots.push({
      id: 'snapshot-1', tripId: 'trip-1', segmentId: 'segment-1', segmentIndex: 0,
      seq: 0, createdAt: 1, points: []
    });
    await expect(previewDamagedIsolation()).resolves.toMatchObject({ trackSnapshots: 1, count: 1 });
    await isolateDamaged();
    await expect(restoreQuarantinedRows()).resolves.toEqual({ restored: 0, skipped: 1 });
  });

  it('keeps quarantined children when their parent is still missing', async () => {
    mocks.state.trackChunks.push({
      id: 'orphan-chunk', tripId: 'missing', segmentId: 'missing-segment', seq: 0, points: []
    });
    await isolateDamaged();
    await expect(restoreQuarantinedRows()).resolves.toEqual({ restored: 0, skipped: 1 });
    expect(mocks.state.quarantine).toHaveLength(1);
    expect(mocks.state.trackChunks).toHaveLength(0);
  });
});
