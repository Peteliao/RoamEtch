import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as any[],
  each: vi.fn()
}));

vi.mock('../src/core/store', () => ({
  db: {
    waypoints: {
      orderBy: vi.fn(() => ({ each: mocks.each }))
    }
  }
}));

import { buildTripFilterIndex } from '../src/core/tripLibrary';

describe('trip filter index loading', () => {
  it('counts nodes and photo references without loading media blobs', async () => {
    mocks.rows = [
      { tripId: 'a', type: 'photo', mediaIds: ['m1'] },
      { tripId: 'a', type: 'note', mediaIds: [] },
      { tripId: 'b', type: 'note', mediaIds: ['m2'] },
      { tripId: 'deleted', type: 'photo', mediaIds: ['m3'] }
    ];
    mocks.each.mockImplementation(async (callback: (row: any) => void) => {
      for (const row of mocks.rows) callback(row);
    });
    const rows = await buildTripFilterIndex([
      { id: 'a', createdAt: 1, statsCache: { distance: 1000 } },
      { id: 'b', createdAt: 2, statsCache: { distance: 2000 } },
      { id: 'c', createdAt: 3, statsCache: { distance: 3000 } }
    ]);
    expect(rows.map((row) => [row.trip.id, row.hasPhotos, row.waypointCount])).toEqual([
      ['a', true, 2], ['b', true, 1], ['c', false, 0]
    ]);
  });

  it('stops with AbortError when the view is destroyed', async () => {
    mocks.each.mockImplementation(async () => {});
    const controller = new AbortController();
    controller.abort();
    await expect(buildTripFilterIndex([], controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
