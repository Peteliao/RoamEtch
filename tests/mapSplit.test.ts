import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn() }));
vi.mock('../src/core/diag', () => ({ diag: vi.fn() }));

import { TrackMap } from '../src/ui/map';
import { toDisplay } from '../src/core/coords';

describe('split map highlight', () => {
  it('keeps recording gaps as separate line features and clears the highlight', () => {
    const setData = vi.fn();
    const map = { getSource: vi.fn(() => ({ setData })) };
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = map;

    trackMap.setSplitHighlight([
      { segmentId: 's1', points: [{ lat: 30, lon: 120 }, { lat: 30, lon: 120.001 }] },
      { segmentId: 's2', points: [{ lat: 31, lon: 121 }, { lat: 31, lon: 121.001 }] }
    ]);

    const collection = setData.mock.calls[0][0];
    expect(map.getSource).toHaveBeenCalledWith('split-highlight');
    expect(collection.features).toHaveLength(2);
    expect(collection.features.map((feature) => feature.geometry.coordinates)).toEqual([
      [[120, 30], [120.001, 30]],
      [[121, 31], [121.001, 31]]
    ]);

    trackMap.setSplitHighlight([]);
    expect(setData.mock.calls[1][0].features).toEqual([]);
  });
});

describe('history map layers', () => {
  it('renders heatmap points in the active display coordinate system', () => {
    const setData = vi.fn();
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'GCJ02';
    (trackMap as any).map = { getSource: vi.fn(() => ({ setData })) };
    const data = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { weight: 3, trips: 1 } }],
      bbox: null, stats: {}
    };

    trackMap.setHeatmap(data);

    const coordinates = setData.mock.calls[0][0].features[0].geometry.coordinates;
    expect(coordinates).not.toEqual([116.4, 39.9]);
    expect(coordinates).toEqual(toDisplay(116.4, 39.9, 'GCJ02'));
  });

  it('keeps overlay tracks separate and honors visibility and opacity', () => {
    const setData = vi.fn();
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = { getSource: vi.fn(() => ({ setData })) };

    trackMap.setOverlayTracks([
      { id: 'a', name: 'A', color: '#ff0000', opacity: 0.4, segments: [{ points: [{ lon: 120, lat: 30 }, { lon: 121, lat: 31 }] }] },
      { id: 'b', visible: false, segments: [{ points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] }] }
    ]);

    const collection = setData.mock.calls[0][0];
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].properties).toEqual({ tripId: 'a', name: 'A', color: '#ff0000', opacity: 0.4 });
    expect(collection.features[0].geometry.coordinates).toEqual([[120, 30], [121, 31]]);
  });
});

describe('live map workload', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const setData = vi.fn();
    const map = { getSource: vi.fn(() => ({ setData })) };
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = map;
    vi.spyOn(trackMap, 'updatePosition').mockImplementation(() => {});
    trackMap.startLive();
    setData.mockClear();
    return { setData, trackMap };
  }

  it('batches rapid fixes into one source update', () => {
    const { setData, trackMap } = setup();

    for (let i = 0; i < 5; i++) trackMap.appendLive({ lat: 30, lon: 120 + i / 1000 }, 's1');
    expect(setData).not.toHaveBeenCalled();

    vi.advanceTimersByTime(179);
    expect(setData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(setData).toHaveBeenCalledTimes(1);
    expect(setData.mock.calls[0][0].features[0].geometry.coordinates).toHaveLength(5);
    trackMap.endLive();
    expect(setData.mock.calls[1][0].features).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds long live geometry while preserving its endpoints', () => {
    const { trackMap } = setup();
    const count = 6100;

    for (let i = 0; i < count; i++) trackMap.appendLive({ lat: 30, lon: 120 + i / 1_000_000 }, 's1');

    const coords = (trackMap as any)._liveFeats.get('s1').geometry.coordinates;
    expect(coords.length).toBeLessThanOrEqual(6000);
    expect(coords.length).toBeGreaterThan(1200);
    expect(coords[0]).toEqual([120, 30]);
    expect(coords.at(-1)).toEqual([120 + (count - 1) / 1_000_000, 30]);
    trackMap.endLive();
  });
});
