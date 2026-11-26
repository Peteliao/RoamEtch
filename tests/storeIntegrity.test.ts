import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state: Record<string, any[]> = { trips: [], segments: [], trackChunks: [], trackSnapshots: [] };
  let failSnapshotDelete = false;
  const makeTable = (name: string) => ({
    toArray: vi.fn(async () => state[name]),
    each: vi.fn(async (visit) => { for (const row of state[name]) visit(row); }),
    bulkDelete: vi.fn(async (ids: string[]) => {
      if (name === 'trackSnapshots' && failSnapshotDelete) throw new Error('delete failed');
      const removed = new Set(ids);
      state[name] = state[name].filter((row) => !removed.has(row.id));
    })
  });
  const db: any = {
    trips: makeTable('trips'), segments: makeTable('segments'),
    trackChunks: makeTable('trackChunks'), trackSnapshots: makeTable('trackSnapshots'),
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

import { abortTransactionOnSignal, isolateDamaged } from '../src/core/store';

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
      { id: 'valid-chunk', tripId: 'trip-1', segmentId: 'valid', points: [] },
      { id: 'orphan-chunk', tripId: 'missing', segmentId: 'orphan', points: [] }
    );
    mocks.state.trackSnapshots.push(
      { id: 'valid-snapshot', tripId: 'trip-1', segmentId: 'valid', points: [] },
      { id: 'orphan-snapshot', tripId: 'missing', segmentId: 'orphan', points: [] }
    );

    await expect(isolateDamaged()).resolves.toBe(3);

    expect(mocks.state.segments.map((row) => row.id)).toEqual(['valid']);
    expect(mocks.state.trackChunks.map((row) => row.id)).toEqual(['valid-chunk']);
    expect(mocks.state.trackSnapshots.map((row) => row.id)).toEqual(['valid-snapshot']);
    expect(mocks.db.transaction).toHaveBeenCalledWith('rw', expect.any(Array), expect.any(Function));
  });

  it('rolls back every isolation delete when a later delete fails', async () => {
    mocks.state.trips.push({ id: 'trip-1' });
    mocks.state.segments.push({ id: 'orphan', tripId: 'missing', index: 0 });
    mocks.state.trackChunks.push({ id: 'orphan-chunk', tripId: 'missing', segmentId: 'orphan', points: [] });
    mocks.state.trackSnapshots.push({ id: 'orphan-snapshot', tripId: 'missing', segmentId: 'orphan', points: [] });
    mocks.failSnapshotDelete();

    await expect(isolateDamaged()).rejects.toThrow('delete failed');

    expect(mocks.state.segments).toHaveLength(1);
    expect(mocks.state.trackChunks).toHaveLength(1);
    expect(mocks.state.trackSnapshots).toHaveLength(1);
  });
});
