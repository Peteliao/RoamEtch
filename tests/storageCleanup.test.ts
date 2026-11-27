import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const waypoints: any[] = [];
  const media: any[] = [];
  const db = {
    waypoints: {
      each: vi.fn(),
      filter: vi.fn(),
      toArray: vi.fn()
    },
    media: {
      each: vi.fn(),
      get: vi.fn(),
      bulkDelete: vi.fn(),
      toArray: vi.fn()
    },
    transaction: vi.fn()
  };
  return { db, waypoints, media };
});

vi.mock('../src/core/store', () => ({ db: mocks.db }));

import { executeMediaCleanup, MediaCleanupTokenError, previewMediaCleanup } from '../src/core/storageHealth';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.waypoints.length = 0;
  mocks.media.length = 0;
  mocks.db.transaction.mockImplementation(async (...args) => args[args.length - 1]());
  mocks.db.waypoints.each.mockImplementation(async (visit) => {
    for (const row of [...mocks.waypoints]) visit(row);
  });
  mocks.db.waypoints.filter.mockImplementation((predicate) => ({
    count: async () => mocks.waypoints.filter(predicate).length
  }));
  mocks.db.waypoints.toArray.mockRejectedValue(new Error('preview must use cursors'));
  mocks.db.media.each.mockImplementation(async (visit) => {
    for (const row of [...mocks.media]) visit(row);
  });
  mocks.db.media.get.mockImplementation(async (id) => mocks.media.find((row) => row.id === id));
  mocks.db.media.bulkDelete.mockImplementation(async (ids) => {
    for (const id of ids) {
      const index = mocks.media.findIndex((row) => row.id === id);
      if (index >= 0) mocks.media.splice(index, 1);
    }
  });
  mocks.db.media.toArray.mockRejectedValue(new Error('preview must use cursors'));
});

afterEach(() => vi.restoreAllMocks());

describe('media storage cleanup', () => {
  it('previews only valid unreferenced media with cursor reads and byte estimates', async () => {
    mocks.waypoints.push({ id: 'w1', mediaIds: ['keep'] });
    mocks.media.push(
      { id: 'keep', blob: new Blob(['keep']) },
      { id: 'unused', blob: new Blob(['1234']), thumb: new Blob(['12']) },
      { id: 'orphan', tripId: 'missing', blob: new Blob(['123']) },
      { id: 'missing-blob', blob: null },
      { id: '', blob: new Blob(['invalid']) }
    );

    const preview = await previewMediaCleanup();

    expect(preview.count).toBe(3);
    expect(preview.bytes).toBe(9);
    expect(preview.sampleIds).toEqual(['unused', 'orphan', 'missing-blob']);
    expect(preview.token).toBeTruthy();
    expect(mocks.db.media.toArray).not.toHaveBeenCalled();
    expect(mocks.db.waypoints.toArray).not.toHaveBeenCalled();
    expect(mocks.db.media.bulkDelete).not.toHaveBeenCalled();
  });

  it('revalidates references inside the delete transaction and consumes the token', async () => {
    mocks.media.push(
      { id: 'newly-referenced', blob: new Blob(['1234']) },
      { id: 'delete-me', blob: new Blob(['123']), thumb: new Blob(['12']) }
    );
    const preview = await previewMediaCleanup();
    mocks.waypoints.push({ id: 'w1', mediaIds: ['newly-referenced'] });

    await expect(executeMediaCleanup(preview.token)).resolves.toEqual({ deleted: 1, bytes: 5, skipped: 1 });
    expect(mocks.media.map((row) => row.id)).toEqual(['newly-referenced']);
    await expect(executeMediaCleanup(preview.token)).rejects.toBeInstanceOf(MediaCleanupTokenError);
  });

  it('keeps media referenced by an orphan waypoint', async () => {
    mocks.waypoints.push({ id: 'orphan-waypoint', tripId: 'missing', mediaIds: ['shared'] });
    mocks.media.push({ id: 'shared', tripId: 'missing', blob: new Blob(['1234']) });
    const preview = await previewMediaCleanup();
    expect(preview.count).toBe(0);
  });

  it('rejects an expired preview without deleting media', async () => {
    mocks.media.push({ id: 'old-preview', blob: new Blob(['1234']) });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const preview = await previewMediaCleanup();
    now.mockReturnValue(1_000 + 5 * 60_000 + 1);
    await expect(executeMediaCleanup(preview.token)).rejects.toBeInstanceOf(MediaCleanupTokenError);
    expect(mocks.media.map((row) => row.id)).toEqual(['old-preview']);
    now.mockRestore();
  });

  it('rechecks preview age after acquiring the cleanup lock', async () => {
    mocks.media.push({ id: 'locked-preview', blob: new Blob(['1234']) });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const preview = await previewMediaCleanup();
    now.mockReturnValueOnce(1_000).mockReturnValue(1_000 + 5 * 60_000 + 1);
    await expect(executeMediaCleanup(preview.token)).rejects.toBeInstanceOf(MediaCleanupTokenError);
    expect(mocks.media.map((row) => row.id)).toEqual(['locked-preview']);
    now.mockRestore();
  });

  it('invalidates the whole preview when a candidate blob is replaced', async () => {
    mocks.media.push(
      { id: 'changed', blob: new Blob(['old!']) },
      { id: 'unchanged', blob: new Blob(['keep']) }
    );
    const preview = await previewMediaCleanup();
    mocks.media[0].blob = new Blob(['new!']);
    await expect(executeMediaCleanup(preview.token)).rejects.toBeInstanceOf(MediaCleanupTokenError);
    expect(mocks.media.map((row) => row.id)).toEqual(['changed', 'unchanged']);
    expect(mocks.db.media.bulkDelete).not.toHaveBeenCalled();
  });

  it('rolls back all deletions when a bulk delete fails', async () => {
    mocks.media.push(
      { id: 'one', blob: new Blob(['1']) },
      { id: 'two', blob: new Blob(['2']) }
    );
    const preview = await previewMediaCleanup();
    mocks.db.media.bulkDelete.mockRejectedValueOnce(new Error('write failed'));
    await expect(executeMediaCleanup(preview.token)).rejects.toThrow('write failed');
    expect(mocks.media.map((row) => row.id)).toEqual(['one', 'two']);
  });
});
