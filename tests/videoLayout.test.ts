import { describe, expect, it } from 'vitest';
import { placeVideoOverlay, routeRectScore, type VideoPoint } from '../src/core/videoLayout';

describe('video overlay placement', () => {
  it('detects route segments crossing an overlay even when both endpoints are outside', () => {
    const route: VideoPoint[] = [[0, 100], [1000, 100]];
    expect(routeRectScore(route, { x: 400, y: 50, w: 200, h: 100 })).toBeGreaterThan(0);
  });

  it('chooses a free corner for a centred route instead of covering it', () => {
    const route: VideoPoint[] = Array.from({ length: 21 }, (_, i) => [540, i * 50]);
    const rect = placeVideoOverlay(route, [{ w: 500, h: 310 }], { w: 1080, h: 1080 });
    expect(rect.score).toBe(0);
    expect(rect.x + rect.w < 540 || rect.x > 540).toBe(true);
  });

  it('keeps overlays inside the map viewport at narrow sizes', () => {
    const rect = placeVideoOverlay([[10, 10]], [{ w: 900, h: 800 }], { w: 320, h: 240 }, 12);
    expect(rect.x).toBeGreaterThanOrEqual(12);
    expect(rect.y).toBeGreaterThanOrEqual(12);
    expect(rect.x + rect.w).toBeLessThanOrEqual(308);
    expect(rect.y + rect.h).toBeLessThanOrEqual(228);
  });
});
