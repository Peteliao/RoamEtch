// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createTrip: vi.fn(),
  addSegment: vi.fn(),
  appendPoints: vi.fn(),
  addWaypoint: vi.fn(),
  updateTrip: vi.fn(),
  deleteTrip: vi.fn(),
  deleteSegment: vi.fn(),
  streamGPX: vi.fn(),
  trips: { add: vi.fn() }
}));

vi.mock('../src/core/store', () => ({
  createTrip: mocks.createTrip,
  addSegment: mocks.addSegment,
  appendPoints: mocks.appendPoints,
  addWaypoint: mocks.addWaypoint,
  updateTrip: mocks.updateTrip,
  deleteTrip: mocks.deleteTrip,
  deleteSegment: mocks.deleteSegment,
  db: { trips: mocks.trips }
}));
vi.mock('../src/core/gpxStream', () => ({ streamGPX: mocks.streamGPX }));

import { importGPXFile } from '../src/core/gpx';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTrip.mockImplementation(async (input) => ({ ...input, updatedAt: 1 }));
  mocks.addSegment.mockResolvedValue({ id: 'segment-1' });
});

describe('streaming GPX import publication', () => {
  it('publishes the trip only after all streamed data is persisted', async () => {
    mocks.streamGPX.mockImplementation(async (_file, onEvent) => {
      expect(mocks.createTrip).not.toHaveBeenCalled();
      await onEvent({ type: 'segment-start', index: 0, source: 'track' });
      await onEvent({ type: 'points', index: 0, points: [{ lat: 1, lon: 2, t: 1 }], source: 'track' });
      await onEvent({ type: 'done', name: 'Streamed', hasTime: true, segments: 1, waypoints: 0 });
      expect(mocks.createTrip).not.toHaveBeenCalled();
      return { name: 'Streamed', hasTime: true, segments: 1, waypoints: 0 };
    });

    const trip = await importGPXFile(new Blob(['<gpx/>']), 'Fallback');

    expect(trip).toMatchObject({ name: 'Streamed', status: 'finished', hasTime: true });
    expect(mocks.addSegment).toHaveBeenCalledWith(trip.id, 1);
    expect(mocks.appendPoints).toHaveBeenCalledWith('segment-1', trip.id, [{ lat: 1, lon: 2, t: 1 }], { allowUnpublished: true });
    expect(mocks.createTrip).toHaveBeenCalledWith({
      id: trip.id, name: 'Streamed', status: 'finished', hasTime: true, publish: false
    });
    expect(mocks.trips.add).toHaveBeenCalledWith(trip);
  });

  it('removes route data and creates an empty track segment when a later track takes precedence', async () => {
    const ids = ['route-segment', 'track-segment'];
    mocks.addSegment.mockImplementation(async () => ({ id: ids.shift() }));
    mocks.streamGPX.mockImplementation(async (_file, onEvent) => {
      await onEvent({ type: 'segment-start', index: 0, source: 'route' });
      await onEvent({ type: 'points', index: 0, points: [{ lat: 1, lon: 2 }], source: 'route' });
      await onEvent({ type: 'segment-end', index: 0, source: 'route' });
      await onEvent({ type: 'segment-start', index: 1, source: 'track' });
      await onEvent({ type: 'segment-end', index: 1, source: 'track' });
      return { name: 'Empty track', hasTime: false, segments: 2, waypoints: 0 };
    });

    const trip = await importGPXFile(new Blob(['<gpx/>']));

    expect(mocks.deleteSegment).toHaveBeenCalledWith('route-segment');
    expect(mocks.addSegment).toHaveBeenLastCalledWith(trip.id);
    expect(mocks.createTrip).toHaveBeenCalledTimes(1);
  });

  it('removes partial child rows when streaming fails after a write', async () => {
    mocks.streamGPX.mockImplementation(async (_file, onEvent) => {
      await onEvent({ type: 'segment-start', index: 0, source: 'track' });
      await onEvent({ type: 'points', index: 0, points: [{ lat: 1, lon: 2, t: 1 }], source: 'track' });
      throw new Error('XML parse error');
    });

    await expect(importGPXFile(new Blob(['<gpx>']))).rejects.toThrow('XML parse error');

    expect(mocks.createTrip).not.toHaveBeenCalled();
    expect(mocks.deleteTrip).toHaveBeenCalledWith(mocks.addSegment.mock.calls[0][0]);
  });
});
