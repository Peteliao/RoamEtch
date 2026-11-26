import { describe, expect, it, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn() }));
vi.mock('../src/core/diag', () => ({ diag: vi.fn() }));

import { TrackMap } from '../src/ui/map';

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
