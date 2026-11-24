import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPrivacy } from '../src/core/privacy';
import { bridgeTrackGapsForExport } from '../src/core/gapRepair';

function trip(segments: any[]) {
  return { trip: { id: 'trip-1', activity: 'hike' }, segments, waypoints: [] };
}

afterEach(() => vi.unstubAllGlobals());

describe('read-only export gap bridging', () => {
  it('routes a real segment break without mutating the saved track', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ features: [{ geometry: { coordinates: [[0.0011, 0], [0.0019, 0]] } }] })
      };
    }));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.002, t: 120_000 }, { lat: 0, lon: 0.003, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 0 }), { radius: 0 });
    expect(requests).toHaveLength(1);
    expect(result.bridged).toBe(1);
    expect(result.points).toBeGreaterThan(0);
    expect(result.segments[0].points.some((p) => p.synth)).toBe(true);
    expect(full.segments[0].points).toHaveLength(2);
    expect(result.segments[0].points.at(-1).lat).toBe(0);
    expect(result.segments[0].points.at(-1).lon).toBeCloseTo(0.002);
  });

  it('removes synthesized route points that enter a privacy circle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ features: [{ geometry: { coordinates: [[0.0001, 0], [0.005, 0.001], [0.0079, 0]] } }] })
    })));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0.001, t: 0 }, { lat: 0, lon: 0.0038, t: 30_000 }, { lat: 0, lon: 0.004, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.008, t: 120_000 }, { lat: 0, lon: 0.0085, t: 150_000 }, { lat: 0, lon: 0.012, t: 180_000 }] }
    ]);
    const cropped = applyPrivacy(full, { radius: 300 });
    expect(cropped.segments).toHaveLength(2);
    const result = await bridgeTrackGapsForExport(full, cropped, { radius: 300 });
    expect(result.bridged).toBe(1);
    const synthetic = result.segments.flatMap((seg) => seg.points).filter((p) => p.synth);
    expect(synthetic.length).toBeGreaterThan(0);
    expect(synthetic.some((p) => p.lon === 0.0001)).toBe(false);
  });

  it('never sends a privacy-hidden endpoint to an external router', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.0025, t: 30_000 }, { lat: 0, lon: 0.003, t: 60_000 }, { lat: 0, lon: 0.0035, t: 90_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.007, t: 120_000 }, { lat: 0, lon: 0.0071, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 300 }), { radius: 300 });
    expect(result.bridged).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the original gap when routing fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const full = trip([
      { id: 'a', points: [{ lat: 0, lon: 0, t: 0 }, { lat: 0, lon: 0.001, t: 60_000 }] },
      { id: 'b', points: [{ lat: 0, lon: 0.002, t: 120_000 }, { lat: 0, lon: 0.003, t: 180_000 }] }
    ]);
    const result = await bridgeTrackGapsForExport(full, applyPrivacy(full, { radius: 0 }), { radius: 0 });
    expect(result.bridged).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.segments[0].points).toHaveLength(2);
  });
});
