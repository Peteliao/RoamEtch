import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeDisplayNames, routeNodeNames } from '../src/core/shareInfo';

const segments = [{ points: [
  { lat: 0, lon: 0, t: 0 },
  { lat: 0, lon: 0.01, t: 1000 },
  { lat: 0, lon: 0.02, t: 2000 },
  { lat: 0, lon: 0.03, t: 3000 }
] }];

afterEach(() => vi.unstubAllGlobals());

describe('route display names', () => {
  it('orders named route nodes along the final route and ignores other node types', () => {
    const names = routeNodeNames({ segments, waypoints: [
      { type: 'route', name: ' 湖口 ', lat: 0, lon: 0.029 },
      { type: 'custom', name: '自定义', lat: 0, lon: 0.005 },
      { type: 'route', name: '山脚', lat: 0, lon: 0.001 },
      { type: 'photo', name: '照片', lat: 0, lon: 0.02 },
      { type: 'route', name: '湖口', lat: 0, lon: 0.028 }
    ] });
    expect(names).toEqual(['山脚', '湖口']);
  });

  it('uses waypoint time only to disambiguate overlapping out-and-back geometry', () => {
    const overlapping = [{ points: [
      { lat: 0, lon: 0, t: 0 },
      { lat: 0, lon: 0.01, t: 1000 },
      { lat: 0, lon: 0, t: 2000 }
    ] }];
    expect(routeNodeNames({ segments: overlapping, waypoints: [
      { type: 'route', name: '返程', lat: 0, lon: 0, time: 2000 },
      { type: 'route', name: '出发', lat: 0, lon: 0, time: 0 }
    ] })).toEqual(['出发', '返程']);
  });

  it('uses custom route names without reverse geocoding', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(routeDisplayNames({ segments, waypoints: [
      { type: 'route', name: '东门', lat: 0, lon: 0.001 }
    ] })).resolves.toEqual(['东门']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
