import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear()
  });
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('city footprint resolution', () => {
  it('crops private endpoints and caches only rounded city coordinates', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(url);
      return {
        ok: true,
        json: async () => ({ features: [{ properties: { city: '杭州' } }] })
      };
    }));
    const { resolveTripCities } = await import('../src/core/shareInfo');
    const points = Array.from({ length: 10 }, (_, i) => ({ lat: 0, lon: i * 0.01, t: i * 60_000 }));
    const full = {
      trip: { id: 'trip-1' },
      segments: [{ id: 'a', points }],
      waypoints: [{ id: 'secret', lat: 0, lon: 0, hidden: true, name: '家' }]
    };
    const cities = await resolveTripCities(full, { radius: 300 });
    expect(cities.length).toBeGreaterThan(0);
    expect(cities.every((city) => city.name === '杭州')).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) {
      const parsed = new URL(url);
      const lat = Number(parsed.searchParams.get('lat'));
      const lon = Number(parsed.searchParams.get('lon'));
      expect(lat).toBeCloseTo(Math.round(lat * 100) / 100);
      expect(lon).toBeCloseTo(Math.round(lon * 100) / 100);
      expect(lon).toBeGreaterThan(0);
      expect(url).not.toContain('家');
    }
    const cached = JSON.parse(localStorage.getItem('roametch.cities.v1') || '{}');
    for (const entry of Object.values(cached) as any[]) {
      expect(Object.keys(entry).sort()).toEqual(['lat', 'lon', 'name', 'ts']);
    }
  });

  it('rejects rounded samples that fall back inside a privacy circle', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { resolveTripCities } = await import('../src/core/shareInfo');
    const full = {
      trip: { id: 'trip-private' },
      segments: [{
        id: 'a',
        points: [
          { lat: 0, lon: 0 },
          { lat: 0.00444, lon: 0 },
          { lat: 0.00446, lon: 0 },
          { lat: 1, lon: 1 }
        ]
      }],
      waypoints: []
    };
    await expect(resolveTripCities(full, { radius: 300 })).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not start geocoding after cancellation', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { routeCities } = await import('../src/core/shareInfo');
    const controller = new AbortController();
    controller.abort();
    await expect(routeCities([
      { points: [{ lat: 30, lon: 120 }, { lat: 30.01, lon: 120.01 }] }
    ], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
