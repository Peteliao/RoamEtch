import { beforeEach, describe, expect, it, vi } from 'vitest';

const emit = vi.hoisted(() => vi.fn());
vi.mock('../src/core/events', () => ({ emit }));

import { clearHistory, pushAction, redo, state, undo } from '../src/core/history';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function scopedAction(label: string, tripId: string, session: number) {
  return {
    label, tripId, session,
    undo: vi.fn().mockResolvedValue(undefined),
    redo: vi.fn().mockResolvedValue(undefined)
  };
}

beforeEach(() => {
  clearHistory();
  emit.mockClear();
});

describe('edit history', () => {
  it('keeps a failed undo action available for retry', async () => {
    const action = {
      label: 'guarded',
      undo: vi.fn().mockRejectedValueOnce(new Error('track-changed')).mockResolvedValue(undefined),
      redo: vi.fn()
    };
    pushAction(action);

    await expect(undo()).rejects.toThrow('track-changed');
    expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 1 });
    expect(emit).toHaveBeenCalledWith('history:changed', state());

    await expect(undo()).resolves.toBe(true);
    expect(action.undo).toHaveBeenCalledTimes(2);
    expect(state()).toEqual({ canUndo: false, canRedo: true, depth: 0 });
  });

  it('keeps a failed redo action available for retry', async () => {
    const action = {
      label: 'guarded',
      undo: vi.fn().mockResolvedValue(undefined),
      redo: vi.fn().mockRejectedValueOnce(new Error('track-changed')).mockResolvedValue(undefined)
    };
    pushAction(action);
    await undo();

    await expect(redo()).rejects.toThrow('track-changed');
    expect(state()).toEqual({ canUndo: false, canRedo: true, depth: 0 });
    expect(emit).toHaveBeenCalledWith('history:changed', state());

    await expect(redo()).resolves.toBe(true);
    expect(action.redo).toHaveBeenCalledTimes(2);
    expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 1 });
  });

  it('serializes concurrent undo requests in stack order', async () => {
    const gate = deferred<void>();
    const first = { label: 'first', undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn() };
    const second = { label: 'second', undo: vi.fn(() => gate.promise), redo: vi.fn() };
    pushAction(first);
    pushAction(second);

    const firstUndo = undo();
    const secondUndo = undo();
    await vi.waitFor(() => expect(second.undo).toHaveBeenCalledTimes(1));
    expect(first.undo).not.toHaveBeenCalled();
    gate.resolve();
    await expect(Promise.all([firstUndo, secondUndo])).resolves.toEqual([true, true]);

    expect(first.undo).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({ canUndo: false, canRedo: true, depth: 0 });
  });

  it('serializes concurrent redo requests in stack order', async () => {
    const gate = deferred<void>();
    const first = { label: 'first', undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn(() => gate.promise) };
    const second = { label: 'second', undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn() };
    pushAction(first);
    pushAction(second);
    await undo();
    await undo();

    const firstRedo = redo();
    const secondRedo = redo();
    await vi.waitFor(() => expect(first.redo).toHaveBeenCalledTimes(1));
    expect(second.redo).not.toHaveBeenCalled();
    gate.resolve();
    await expect(Promise.all([firstRedo, secondRedo])).resolves.toEqual([true, true]);

    expect(second.redo).toHaveBeenCalledTimes(1);
    expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 2 });
  });

  it('queues a new branch until an in-flight undo completes', async () => {
    const gate = deferred<void>();
    const pending = { label: 'pending', undo: vi.fn(() => gate.promise), redo: vi.fn() };
    const branch = { label: 'branch', undo: vi.fn(), redo: vi.fn() };
    pushAction(pending);

    const operation = undo();
    await vi.waitFor(() => expect(pending.undo).toHaveBeenCalledTimes(1));
    pushAction(branch);
    gate.resolve();
    await expect(operation).resolves.toBe(true);

    expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 1 });
    await undo();
    expect(branch.undo).toHaveBeenCalledTimes(1);
    expect(pending.undo).toHaveBeenCalledTimes(1);
  });

  it('keeps a pushed action behind all earlier queued undo operations', async () => {
    const gate = deferred<void>();
    const first = { label: 'first', undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn() };
    const second = { label: 'second', undo: vi.fn(() => gate.promise), redo: vi.fn() };
    const branch = { label: 'branch', undo: vi.fn(), redo: vi.fn() };
    pushAction(first);
    pushAction(second);

    const undoSecond = undo();
    const undoFirst = undo();
    pushAction(branch);
    await vi.waitFor(() => expect(second.undo).toHaveBeenCalledTimes(1));
    expect(first.undo).not.toHaveBeenCalled();
    gate.resolve();
    await expect(Promise.all([undoSecond, undoFirst])).resolves.toEqual([true, true]);
    await vi.waitFor(() => expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 1 }));

    expect(first.undo).toHaveBeenCalledTimes(1);
    expect(branch.undo).not.toHaveBeenCalled();
    await undo();
    expect(branch.undo).toHaveBeenCalledTimes(1);
  });

  it('runs a queued clear after earlier undo operations', async () => {
    const gate = deferred<void>();
    const first = { label: 'first', undo: vi.fn().mockResolvedValue(undefined), redo: vi.fn() };
    const second = { label: 'second', undo: vi.fn(() => gate.promise), redo: vi.fn() };
    pushAction(first);
    pushAction(second);

    const undoSecond = undo();
    const undoFirst = undo();
    clearHistory();
    gate.resolve();
    await expect(Promise.all([undoSecond, undoFirst])).resolves.toEqual([true, true]);
    await vi.waitFor(() => expect(state()).toEqual({ canUndo: false, canRedo: false, depth: 0 }));

    expect(first.undo).toHaveBeenCalledTimes(1);
    expect(second.undo).toHaveBeenCalledTimes(1);
  });

  it('discards stale undo actions from another trip or session without executing them', async () => {
    const current = scopedAction('current', 'a', 2);
    const staleSession = scopedAction('stale-session', 'a', 1);
    const staleTrip = scopedAction('stale-trip', 'b', 2);
    pushAction(current);
    pushAction(staleSession);
    pushAction(staleTrip);

    await expect(undo({ tripId: 'a', session: 2 })).resolves.toBe(true);

    expect(current.undo).toHaveBeenCalledTimes(1);
    expect(staleSession.undo).not.toHaveBeenCalled();
    expect(staleTrip.undo).not.toHaveBeenCalled();
    expect(state()).toEqual({ canUndo: false, canRedo: true, depth: 0 });
  });

  it('clears an undo stack containing only actions outside the requested scope', async () => {
    const staleSession = scopedAction('stale-session', 'a', 1);
    const staleTrip = scopedAction('stale-trip', 'b', 2);
    pushAction(staleSession);
    pushAction(staleTrip);

    await expect(undo({ tripId: 'a', session: 2 })).resolves.toBe(false);

    expect(staleSession.undo).not.toHaveBeenCalled();
    expect(staleTrip.undo).not.toHaveBeenCalled();
    expect(state()).toEqual({ canUndo: false, canRedo: false, depth: 0 });
  });

  it('discards stale redo actions from another trip or session without executing them', async () => {
    const current = scopedAction('current', 'a', 2);
    const staleTrip = scopedAction('stale-trip', 'b', 2);
    const staleSession = scopedAction('stale-session', 'a', 1);
    for (const action of [staleSession, staleTrip, current]) pushAction(action);
    await undo();
    await undo();
    await undo();
    vi.clearAllMocks();

    await expect(redo({ tripId: 'a', session: 2 })).resolves.toBe(true);

    expect(current.redo).toHaveBeenCalledTimes(1);
    expect(staleSession.redo).not.toHaveBeenCalled();
    expect(staleTrip.redo).not.toHaveBeenCalled();
    expect(state()).toEqual({ canUndo: true, canRedo: false, depth: 1 });
  });

  it('clears a redo stack containing only actions outside the requested scope', async () => {
    const staleTrip = scopedAction('stale-trip', 'b', 2);
    const staleSession = scopedAction('stale-session', 'a', 1);
    pushAction(staleTrip);
    pushAction(staleSession);
    await undo();
    await undo();
    vi.clearAllMocks();

    await expect(redo({ tripId: 'a', session: 2 })).resolves.toBe(false);

    expect(staleSession.redo).not.toHaveBeenCalled();
    expect(staleTrip.redo).not.toHaveBeenCalled();
    expect(state()).toEqual({ canUndo: false, canRedo: false, depth: 0 });
  });
});
