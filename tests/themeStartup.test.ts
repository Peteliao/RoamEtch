import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listTrips: vi.fn(),
  loadFirstTrackPoint: vi.fn(),
  loadTripFull: vi.fn()
}));

vi.mock('../src/core/settings', () => ({ get: vi.fn(() => 'dark') }));
vi.mock('../src/core/themeRegistry', () => ({
  appCssVars: vi.fn(() => ({})),
  isConcreteTheme: vi.fn(() => true),
  themeDefinition: vi.fn(() => ({ palette: { vectorBg: '#000000' } }))
}));
vi.mock('../src/core/events', () => ({ on: vi.fn(), emit: vi.fn() }));
vi.mock('../src/core/region', () => ({ regionState: { effective: 'cn' } }));
vi.mock('../src/core/solar', () => ({ sunTimes: vi.fn() }));
vi.mock('../src/core/store', () => ({
  listTrips: mocks.listTrips,
  loadFirstTrackPoint: mocks.loadFirstTrackPoint,
  loadTripFull: mocks.loadTripFull
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', {
    documentElement: { dataset: {}, style: { setProperty: vi.fn() } },
    querySelector: vi.fn(() => ({ setAttribute: vi.fn() }))
  });
});

describe('theme startup', () => {
  it('uses a bounded first-point lookup instead of loading the latest full trip', async () => {
    mocks.listTrips.mockResolvedValue([{ id: 'trip-1' }]);
    mocks.loadFirstTrackPoint.mockResolvedValue({ lat: 30, lon: 120 });

    const { initTheme, themeInfo } = await import('../src/core/theme');
    await initTheme();

    expect(mocks.loadFirstTrackPoint).toHaveBeenCalledWith('trip-1');
    expect(mocks.loadTripFull).not.toHaveBeenCalled();
    expect(themeInfo().ref).toEqual({ lat: 30, lon: 120 });
  });
});
