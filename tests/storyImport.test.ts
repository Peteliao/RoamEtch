import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTrip, deleteTrip, db, importMatchedPhotos } from '../src/core/store';

let ids: string[] = [];

afterEach(async () => {
  for (const id of ids) {
    try { await deleteTrip(id); } catch { /* already gone */ }
  }
  ids = [];
});

async function trip() {
  const created = await createTrip({ name: 'Import test', activity: 'hike', status: 'done' });
  ids.push(created.id);
  return created;
}

function photo(tag: string) {
  return {
    blob: new Blob([tag], { type: 'image/jpeg' }),
    thumb: new Blob([tag], { type: 'image/jpeg' }),
    width: 100,
    height: 80
  };
}

describe('confirmed photo association writes', () => {
  it('links photos to existing nodes and creates new photo nodes', async () => {
    const t = await trip();
    const existing = {
      id: 'node-1', tripId: t.id, name: 'Ridge', type: 'view',
      lat: 30, lon: 120, time: Date.now(), hidden: false, mediaIds: []
    };
    await db.waypoints.add(existing);
    const result = await importMatchedPhotos({
      tripId: t.id,
      items: [
        { photo: photo('a'), candidate: { lat: 30, lon: 120, time: Date.now(), waypointId: 'node-1' } },
        { photo: photo('b'), candidate: { lat: 30.1, lon: 120.1, time: Date.now(), waypointId: null } }
      ],
      nameFor: (n) => `Photo ${n}`
    });
    expect(result).toEqual({ linked: 1, created: 1 });
    const linked = await db.waypoints.get('node-1');
    expect(linked.mediaIds).toHaveLength(1);
    const created = await db.waypoints.where('tripId').equals(t.id).filter((w) => w.type === 'photo').toArray();
    expect(created).toHaveLength(1);
    expect(created[0].name).toBe('Photo 1');
    expect(await db.media.where('tripId').equals(t.id).count()).toBe(2);
  });

  it('does not write anything when no item is confirmed', async () => {
    const t = await trip();
    const result = await importMatchedPhotos({ tripId: t.id, items: [] });
    expect(result).toEqual({ linked: 0, created: 0 });
    expect(await db.media.where('tripId').equals(t.id).count()).toBe(0);
    expect(await db.waypoints.where('tripId').equals(t.id).count()).toBe(0);
  });
});
