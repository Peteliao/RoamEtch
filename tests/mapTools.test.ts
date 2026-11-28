// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadTripTrack: vi.fn(),
  simplifyAsync: vi.fn(),
  resolveAltitude: vi.fn(),
  setData: vi.fn(),
  fitBounds: vi.fn(),
  flyTo: vi.fn(),
  remove: vi.fn(),
  resize: vi.fn()
}));

vi.mock('maplibre-gl', () => ({ setWorkerUrl: vi.fn() }));
vi.mock('../src/core/store', () => ({ loadTripTrack: mocks.loadTripTrack }));
vi.mock('../src/core/workerBridge', () => ({ simplifyAsync: mocks.simplifyAsync }));
vi.mock('../src/core/elevation', () => ({ resolveAltitude: mocks.resolveAltitude }));
vi.mock('../src/core/i18n', () => ({ t: (key: string) => key, currentLang: () => 'zh' }));
vi.mock('../src/ui/history', () => ({
  onUIPop: vi.fn(),
  pushUIState: () => ({ id: 1 }),
  backFromUIState: vi.fn().mockResolvedValue(undefined),
  currentUIState: () => null
}));

import {
  MAP_TOOLS_MAX_OVERLAY_TRACKS,
  MAP_TOOLS_MAX_POINTS_PER_TRACK,
  MAP_TOOLS_STORAGE_KEY,
  altitudeSourceKey,
  computeSegmentSlopes,
  loadMapToolsPreferences,
  normalizeMapToolsPreferences,
  openMapTools,
  parseWgs84Coordinate,
  prepareMapTrack,
  serializeMapToolsPreferences,
  type MapToolsHandle,
  type MapToolsLayerPreference
} from '../src/ui/mapTools';
import { TrackMap } from '../src/ui/map';
import { haversine } from '../src/core/geo';
import { wgs84ToGcj02 } from '../src/core/coords';

const trips = [
  { id: 'a', name: 'Alpha', status: 'finished', createdAt: 1700000000000 },
  { id: 'b', name: 'Beta', status: 'finished', createdAt: 1700000001000 },
  { id: 'recording', name: 'Live', status: 'recording', createdAt: 1700000002000 }
];

const fullTrip = {
  trip: trips[0],
  segments: [
    { id: 'a-1', points: [
      { lat: 30, lon: 120, alt: 100 },
      { lat: 30, lon: 120.001, alt: 110 },
      { lat: 30.001, lon: 120.001, alt: null }
    ] },
    { id: 'a-2', points: [
      { lat: 31, lon: 121, alt: 200 },
      { lat: 31, lon: 121.001, alt: 190 }
    ] }
  ]
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeMap() {
  return {
    getSource: vi.fn(() => ({ setData: mocks.setData })),
    fitBounds: mocks.fitBounds,
    flyTo: mocks.flyTo,
    remove: mocks.remove,
    resize: mocks.resize
  };
}

function stubMapInit() {
  return vi.spyOn(TrackMap.prototype, 'init').mockImplementation(function (this: TrackMap) {
    (this as any).map = fakeMap();
    return this;
  });
}

const handles: MapToolsHandle[] = [];

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  mocks.simplifyAsync.mockImplementation(async (points) => points);
  mocks.loadTripTrack.mockResolvedValue(fullTrip);
  mocks.resolveAltitude.mockResolvedValue({ alt: 123.4, src: 'svc' });
});

afterEach(() => {
  for (const handle of handles.splice(0)) {
    if (handle.backdrop.isConnected) handle.close();
  }
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as any).scrollIntoView;
});

describe('map-tools coordinate parsing', () => {
  it('parses decimal latitude,longitude and validates ranges and syntax', () => {
    expect(parseWgs84Coordinate(' 39.9042 , 116.4074 ', 'WGS84')).toEqual({ lat: 39.9042, lon: 116.4074 });
    expect(parseWgs84Coordinate('39.9042，116.4074', 'WGS84')).toEqual({ lat: 39.9042, lon: 116.4074 });
    for (const invalid of ['', '39', '39, 116, 1', '91, 116', '39, 181', 'NaN, 116', 'Infinity, 116', '0x10, 116']) {
      expect(parseWgs84Coordinate(invalid, 'WGS84')).toBeNull();
    }
  });

  it('converts an explicit GCJ-02 input back to WGS-84', () => {
    const original = { lat: 39.9042, lon: 116.4074 };
    const [lon, lat] = wgs84ToGcj02(original.lon, original.lat);
    const parsed = parseWgs84Coordinate(`${lat}, ${lon}`, 'GCJ02')!;
    expect(parsed.lat).toBeCloseTo(original.lat, 6);
    expect(parsed.lon).toBeCloseTo(original.lon, 6);
  });
});

describe('map-tools slope preparation', () => {
  it('computes adjacent-edge grades from measured altitude and distance only', () => {
    const points = [
      { lat: 30, lon: 120, alt: 100 },
      { lat: 30, lon: 120.001, alt: 110 },
      { lat: 30, lon: 120.002, alt: null },
      { lat: 30, lon: 120.003, alt: 90 },
      { lat: 30, lon: 120.004, alt: 100 }
    ];
    const slopes = computeSegmentSlopes(points);
    const distance = haversine(30, 120, 30, 120.001);
    expect(slopes[0]).toBeCloseTo((10 / distance) * 100, 8);
    expect(slopes[1]).toBeNull();
    expect(slopes[2]).toBeNull();
    expect(slopes[3]).toBeCloseTo((10 / distance) * 100, 8);
    expect(slopes[4]).toBeNull();
  });

  it('does not invent a grade for zero distance or non-finite altitude', () => {
    expect(computeSegmentSlopes([
      { lat: 30, lon: 120, alt: 10 },
      { lat: 30, lon: 120, alt: 20 },
      { lat: 30, lon: 120.001, alt: Number.NaN },
      { lat: 30, lon: 120.002, alt: 30 }
    ])).toEqual([null, null, null, null]);
  });

  it('prepares recording segments independently and simplifies longer segments', async () => {
    const prepared = await prepareMapTrack(fullTrip);
    expect(mocks.simplifyAsync).toHaveBeenCalledTimes(1);
    expect(mocks.simplifyAsync).toHaveBeenNthCalledWith(1, fullTrip.segments[0].points, 5, { signal: undefined });
    expect(prepared?.segments).toHaveLength(2);
    expect(prepared?.segments[0].slopes[0]).toBeGreaterThan(0);
    expect(prepared?.segments[0].slopes[1]).toBeNull();
    expect(prepared?.segments[1].slopes[0]).toBeLessThan(0);
    expect(prepared?.bbox).toEqual([120, 30, 121.001, 31]);
    expect(prepared?.pointLimited).toBe(false);
    expect(prepared?.hasAltitude).toBe(true);
  });

  it('bounds displayed points per track while retaining segment endpoints', async () => {
    const prepared = await prepareMapTrack(fullTrip, { maxPoints: 4 });
    expect(prepared?.pointCount).toBe(3);
    expect(prepared?.pointLimited).toBe(true);
    expect(prepared?.segments).toHaveLength(1);
    expect(prepared?.segments[0].points[0]).toEqual(fullTrip.segments[0].points[0]);
    expect(prepared?.segments[0].points.at(-1)).toEqual(fullTrip.segments[0].points[2]);
    const many = Array.from({ length: MAP_TOOLS_MAX_POINTS_PER_TRACK + 5 }, (_, index) => ({
      lat: 30, lon: 120 + index / 1_000_000, alt: index
    }));
    const limited = await prepareMapTrack({ trip: trips[0], segments: [{ points: many }] });
    expect(limited?.pointCount).toBe(MAP_TOOLS_MAX_POINTS_PER_TRACK);
    expect(limited?.pointLimited).toBe(true);
    expect(limited?.segments[0].points.at(-1)).toEqual(many.at(-1));
  });

  it('uses an antimeridian-crossing bbox for short edges without spanning the globe', async () => {
    const prepared = await prepareMapTrack({
      trip: trips[0],
      segments: [{ points: [{ lat: 0, lon: 179.99 }, { lat: 0, lon: -179.99 }] }]
    });
    expect(prepared?.bbox).toEqual([179.99, 0, -179.99, 0]);
  });

  it('passes cancellation to simplification and rejects stale preparation', async () => {
    const pending = deferred<any[]>();
    mocks.simplifyAsync.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const preparing = prepareMapTrack(fullTrip, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.simplifyAsync).toHaveBeenCalled());
    const signal = mocks.simplifyAsync.mock.calls[0][2].signal as AbortSignal;
    controller.abort();
    pending.resolve(fullTrip.segments[0].points);
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal.aborted).toBe(true);
  });
});

describe('map-tools preference persistence', () => {
  it('allow-lists IDs and layer fields and strips geometry from untrusted storage', () => {
    const normalized = normalizeMapToolsPreferences({
      version: 1,
      selectedIds: ['a', 'a', 'missing', 3],
      geometry: [{ lat: 30, lon: 120 }],
      layers: {
        a: { visible: false, color: '#AABBCC', opacity: 0.42, slope: true, points: [{ lat: 30, lon: 120 }] },
        b: { visible: 'yes', color: 'red', opacity: '0.5', slope: 1 }
      }
    }, trips);
    expect(normalized.selectedIds).toEqual(['a']);
    expect(normalized.layers.a).toEqual({ selected: true, visible: false, color: '#aabbcc', opacity: 0.42, slope: true });
    expect(normalized.layers.b).toEqual({ selected: false, visible: true, color: '#5aa7f0', opacity: 0.82, slope: false });
    expect(normalized.layers.recording).toBeUndefined();
    expect(JSON.stringify(normalized)).not.toContain('geometry');
    expect(JSON.stringify(normalized)).not.toContain('points');
  });

  it('serializes only preferences under the versioned key and round-trips them', () => {
    const layers = new Map<string, MapToolsLayerPreference>([
      ['a', { selected: true, visible: true, color: '#112233', opacity: 0.65, slope: true }],
      ['b', { selected: false, visible: false, color: '#445566', opacity: 0.3, slope: false }]
    ]);
    const stored = JSON.parse(serializeMapToolsPreferences(layers));
    expect(Object.keys(stored)).toEqual(['version', 'selectedIds', 'order', 'layers']);
    expect(stored.order).toEqual(['a', 'b']);
    expect(stored.layers.a).toEqual({ visible: true, color: '#112233', opacity: 0.65, slope: true });
    expect(stored.layers.a.selected).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('lat');
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify(stored));
    expect(MAP_TOOLS_STORAGE_KEY).toBe('roametch.mapTools.v1');
    expect(loadMapToolsPreferences(trips)).toEqual(normalizeMapToolsPreferences(stored, trips));
  });

  it('restores a persisted layer order, removes duplicates and appends unseen trips', () => {
    const normalized = normalizeMapToolsPreferences({
      version: 1, selectedIds: ['a', 'b'],
      order: ['b', 'missing', 'b', 'a'],
      layers: { a: {}, b: {} }
    }, trips);
    expect(normalized.order).toEqual(['b', 'a']);
    const withoutOrder = normalizeMapToolsPreferences({ version: 1, selectedIds: [], layers: {} }, trips);
    expect(withoutOrder.order).toEqual(['a', 'b']);
  });

  it('defaults to the first finished trip only when no saved selection exists', () => {
    const defaults = loadMapToolsPreferences(trips);
    expect(defaults.selectedIds).toEqual(['a']);
    expect(defaults.layers.a.selected).toBe(true);
    expect(defaults.layers.b.selected).toBe(false);
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, selectedIds: [], layers: {} }));
    expect(loadMapToolsPreferences(trips).selectedIds).toEqual([]);
  });

  it('maps every altitude result to an honest source label', () => {
    expect(altitudeSourceKey('gps')).toBe('mapTools.sourceGps');
    expect(altitudeSourceKey('cache')).toBe('mapTools.sourceCache');
    expect(altitudeSourceKey('svc')).toBe('mapTools.sourceService');
    expect(altitudeSourceKey(null)).toBe('mapTools.sourceUnavailable');
    expect(altitudeSourceKey('invented')).toBe('mapTools.sourceUnavailable');
  });
});

describe('TrackMap overlay slope painting', () => {
  it('unwraps short antimeridian edges and fits crossing bounds without spanning the globe', () => {
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = fakeMap();
    expect((trackMap as any)._displayCoords([
      { lon: 179.99, lat: 0 }, { lon: -179.99, lat: 0 }, { lon: -179.98, lat: 0 }
    ])).toEqual([[179.99, 0], [180.01, 0], [180.02, 0]]);
    trackMap.fitWgs84Bounds([179.99, 0, -179.99, 0], 44);
    expect(mocks.fitBounds).toHaveBeenCalledWith([[179.99, 0], [180.01, 0]], expect.any(Object));
  });

  it('replays a pending heatmap after the style loads', () => {
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    const setData = vi.fn();
    const sources = new Map<string, any>();
    const once = vi.fn();
    (trackMap as any).map = {
      getSource: (id: string) => sources.get(id),
      isStyleLoaded: () => false,
      once
    };
    const heatmap = {
      bbox: [120, 30, 121, 31],
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [120.5, 30.5] } }]
    };
    trackMap.setHeatmap(heatmap);
    expect(once).toHaveBeenCalledWith('style.load', expect.any(Function));
    sources.set('personal-heatmap', { setData });
    once.mock.calls[0][1]();
    expect(setData).toHaveBeenCalledWith({ type: 'FeatureCollection', features: heatmap.features });
  });

  it('paints adjacent edges without crossing segments and falls back for missing slope', () => {
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = fakeMap();
    trackMap.setOverlayTracks([{
      id: 'a', name: 'Alpha', color: '#ff0000', opacity: 0.4, slope: true,
      segments: [
        { points: [{ lon: 120, lat: 30 }, { lon: 120.001, lat: 30 }, { lon: 120.002, lat: 30 }], slopes: [10, null] },
        { points: [{ lon: 121, lat: 31 }, { lon: 121.001, lat: 31 }], slopes: [-5] }
      ]
    }]);
    const features = mocks.setData.mock.calls.at(-1)![0].features;
    expect(features).toHaveLength(3);
    expect(features[0].properties.slope).toBe(10);
    expect(features[1].properties.slope).toBeUndefined();
    expect(features[1].properties.color).toBe('#ff0000');
    expect(features[2].properties.slope).toBe(-5);
    expect(features.map((feature) => feature.geometry.coordinates)).toEqual([
      [[120, 30], [120.001, 30]],
      [[120.001, 30], [120.002, 30]],
      [[121, 31], [121.001, 31]]
    ]);
    expect(features[1].geometry.coordinates[1]).not.toEqual(features[2].geometry.coordinates[0]);
  });

  it('omits slope properties entirely when slope coloring is off', () => {
    const trackMap = new TrackMap({} as any);
    (trackMap as any).coordSystem = 'WGS84';
    (trackMap as any).map = fakeMap();
    trackMap.setOverlayTracks([{
      id: 'a', slope: false,
      segments: [{ points: [{ lon: 120, lat: 30 }, { lon: 121, lat: 31 }], slopes: [12] }]
    }]);
    const features = mocks.setData.mock.calls.at(-1)![0].features;
    expect(features).toHaveLength(1);
    expect(features[0].properties).not.toHaveProperty('slope');
  });

  it('uses a slope expression with an explicit track-color fallback', () => {
    const sources = new Map<string, any>();
    const layers = new Map<string, any>();
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, source: any) => sources.set(id, { ...source, setData: vi.fn() }),
      getLayer: (id: string) => layers.get(id),
      addLayer: (layer: any) => layers.set(layer.id, layer)
    };
    const trackMap = new TrackMap({} as any);
    (trackMap as any).map = map;
    trackMap._addTrackLayers();
    const expression = layers.get('overlay-track-line').paint['line-color'];
    expect(expression[0]).toBe('case');
    expect(expression[1]).toEqual(['has', 'slope']);
    expect(expression[2][0]).toBe('interpolate');
    expect(expression[3]).toEqual(['coalesce', ['get', 'color'], '#2bcda7']);
  });
});

describe('map-tools modal behavior', () => {
  it('lazy-loads once, reuses the modal cache, identifies clicked trips, and destroys its map', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({
      version: 1, selectedIds: ['a'],
      layers: { a: { visible: true, color: '#123456', opacity: 0.7, slope: false } }
    }));
    const handle = openMapTools(trips);
    handles.push(handle);
    await vi.waitFor(() => expect(mocks.setData.mock.calls.at(-1)![0].features.length).toBeGreaterThan(0));
    expect(mocks.loadTripTrack).toHaveBeenCalledTimes(1);
    expect(mocks.loadTripTrack).toHaveBeenCalledWith('a');
    expect(mocks.simplifyAsync).toHaveBeenCalledTimes(1);

    const row = handle.box.querySelector('[data-trip-id="a"]') as HTMLElement;
    const visibility = row.querySelector('.mt-switch-row input') as HTMLInputElement;
    visibility.checked = false;
    visibility.dispatchEvent(new Event('change', { bubbles: true }));
    expect(mocks.setData.mock.calls.at(-1)![0].features).toEqual([]);
    visibility.checked = true;
    visibility.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mocks.setData.mock.calls.at(-1)![0].features.length).toBeGreaterThan(0));
    expect(mocks.loadTripTrack).toHaveBeenCalledTimes(2);

    const color = row.querySelector('input[type="color"]') as HTMLInputElement;
    color.value = '#abcdef';
    color.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mocks.setData.mock.calls.at(-1)![0].features[0].properties.color).toBe('#abcdef');
    (handle.map as any).opts.onOverlayTrackClick({ tripId: 'a' });
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.classList.contains('is-focused')).toBe(true);

    handle.close();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });

  it('orders overlays up and down and persists the layer order', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({
      version: 1, selectedIds: ['a', 'b'], order: ['a', 'b'], layers: {}
    }));
    const paint = vi.spyOn(TrackMap.prototype, 'setOverlayTracks');
    const handle = openMapTools(trips);
    handles.push(handle);
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(paint.mock.calls.at(-1)![0]).toHaveLength(2));
    const rowIds = () => [...handle.box.querySelectorAll('[data-trip-id]')].map((row) => row.getAttribute('data-trip-id'));
    expect(rowIds()).toEqual(['a', 'b']);

    const betaRow = handle.box.querySelector('[data-trip-id="b"]') as HTMLElement;
    (betaRow.querySelector('.mt-order-button') as HTMLButtonElement).click();
    expect(rowIds()).toEqual(['b', 'a']);
    expect(paint.mock.calls.at(-1)![0].map((track: any) => track.id)).toEqual(['b', 'a']);
    expect(JSON.parse(localStorage.getItem(MAP_TOOLS_STORAGE_KEY)!).order).toEqual(['b', 'a']);
    expect((betaRow.querySelector('.mt-order-button') as HTMLButtonElement).disabled).toBe(true);
    expect((betaRow.querySelectorAll('.mt-order-button')[1] as HTMLButtonElement).disabled).toBe(false);
    handle.close();
  });

  it('fills WGS-84 coordinates from an explicit map pick without querying elevation', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, selectedIds: [], layers: {} }));
    const handle = openMapTools(trips);
    handles.push(handle);
    const hover = vi.spyOn(TrackMap.prototype, 'showHover').mockImplementation(() => {});
    const pick = handle.box.querySelector('.mt-pick-button') as HTMLButtonElement;
    const input = handle.box.querySelector('.mt-coordinate-input') as HTMLInputElement;
    const datum = handle.box.querySelector('.mt-datum-select') as HTMLSelectElement;
    datum.value = 'GCJ02';

    pick.click();
    expect(pick.getAttribute('aria-pressed')).toBe('true');
    expect(handle.box.querySelector('.mt-coordinate-message')?.textContent).toBe('mapTools.pickActive');
    (handle.map as any).opts.onElevationPick(116.4074, 39.9042);

    expect(input.value).toBe('39.904200, 116.407400');
    expect(datum.value).toBe('WGS84');
    expect(pick.getAttribute('aria-pressed')).toBe('false');
    expect(handle.box.querySelector('.mt-coordinate-message')?.textContent).toBe('mapTools.pickedCoordinate');
    expect(hover).toHaveBeenCalledWith(39.9042, 116.4074, 'mapTools.coordinatePin');
    expect(mocks.resolveAltitude).not.toHaveBeenCalled();

    (handle.box.querySelector('.mt-elevation-query .btn') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mocks.resolveAltitude).toHaveBeenCalledWith(39.9042, 116.4074, null, null));
    handle.close();
  });

  it('caps overlays, reports deferred tracks, evicts hidden cache, and paints once per batch', async () => {
    stubMapInit();
    const manyTrips = Array.from({ length: MAP_TOOLS_MAX_OVERLAY_TRACKS + 2 }, (_, index) => ({
      id: String.fromCharCode(97 + index), name: `Track ${index}`, status: 'finished', createdAt: 1700000000000 + index
    }));
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({
      version: 1, selectedIds: manyTrips.map((trip) => trip.id), layers: {}
    }));
    const paint = vi.spyOn(TrackMap.prototype, 'setOverlayTracks');
    const handle = openMapTools(manyTrips);
    handles.push(handle);
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledTimes(MAP_TOOLS_MAX_OVERLAY_TRACKS));
    await vi.waitFor(() => expect(mocks.setData.mock.calls.at(-1)![0].features.length).toBeGreaterThan(0));
    const tracks = paint.mock.calls.at(-1)![0];
    expect(tracks).toHaveLength(MAP_TOOLS_MAX_OVERLAY_TRACKS);
    expect(paint).toHaveBeenCalledTimes(2);
    const deferredRow = handle.box.querySelector(`[data-trip-id="${manyTrips.at(-1)!.id}"]`) as HTMLElement;
    expect(deferredRow.dataset.status).toBe('deferred');
    expect(deferredRow.querySelector('.mt-layer-status')?.textContent).toBe('mapTools.deferredTrack');
    expect(handle.box.querySelector('.mt-map-caption-text')?.textContent).toBe('mapTools.overlayLimit');

    const firstRow = handle.box.querySelector('[data-trip-id="a"]') as HTMLElement;
    const visibility = firstRow.querySelector('.mt-switch-row input') as HTMLInputElement;
    visibility.checked = false;
    visibility.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledTimes(MAP_TOOLS_MAX_OVERLAY_TRACKS + 1));
    await vi.waitFor(() => expect(mocks.setData.mock.calls.at(-1)![0].features.length).toBeGreaterThan(0));
    expect(mocks.loadTripTrack).toHaveBeenCalledWith(manyTrips[MAP_TOOLS_MAX_OVERLAY_TRACKS].id);

    visibility.checked = true;
    visibility.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledTimes(MAP_TOOLS_MAX_OVERLAY_TRACKS + 2));
    expect(mocks.loadTripTrack).toHaveBeenLastCalledWith('a');
  });

  it('fits multiple dateline tracks around the antimeridian', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({
      version: 1, selectedIds: ['a', 'b'], layers: {}
    }));
    mocks.loadTripTrack.mockImplementation(async (id: string) => ({
      trip: { ...trips[0], id, name: id },
      segments: [{ points: [
        { lat: 0, lon: id === 'a' ? 179.99 : -179.98 },
        { lat: 1, lon: id === 'a' ? -179.99 : -179.97 }
      ] }]
    }));
    const handle = openMapTools(trips);
    handles.push(handle);
    await vi.waitFor(() => expect(mocks.loadTripTrack).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(mocks.setData.mock.calls.at(-1)![0].features.length).toBeGreaterThan(0));
    const fit = [...handle.box.querySelectorAll('button')]
      .find((button) => button.textContent === 'mapTools.fitAll') as HTMLButtonElement;
    fit.click();
    expect(mocks.fitBounds).toHaveBeenCalled();
    const fitted = mocks.fitBounds.mock.calls.at(-1)![0] as [[number, number], [number, number]];
    expect(fitted[0][0]).toBeCloseTo(179.99, 8);
    expect(fitted[0][1]).toBe(0);
    expect(fitted[1][0]).toBeCloseTo(180.03, 8);
    expect(fitted[1][1]).toBe(1);
  });

  it('aborts stale work on selection changes and on destroy', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({
      version: 1, selectedIds: ['a'],
      layers: { a: { visible: true, color: '#123456', opacity: 0.8, slope: false } }
    }));
    const first = deferred<any[]>();
    const second = deferred<any[]>();
    mocks.simplifyAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const handle = openMapTools(trips);
    handles.push(handle);
    await vi.waitFor(() => expect(mocks.simplifyAsync).toHaveBeenCalledTimes(1));
    const firstSignal = mocks.simplifyAsync.mock.calls[0][2].signal as AbortSignal;
    const select = handle.box.querySelector('[data-trip-id="a"] .mt-layer-select input') as HTMLInputElement;
    select.checked = false;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(firstSignal.aborted).toBe(true);
    first.resolve(fullTrip.segments[0].points);
    await Promise.resolve();
    expect(mocks.setData.mock.calls.at(-1)![0].features).toEqual([]);

    select.checked = true;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(mocks.simplifyAsync).toHaveBeenCalledTimes(2));
    const secondSignal = mocks.simplifyAsync.mock.calls[1][2].signal as AbortSignal;
    handle.close();
    expect(secondSignal.aborted).toBe(true);
    second.resolve(fullTrip.segments[0].points);
  });

  it('flies to converted coordinates and queries elevation only on request with source disclosure', async () => {
    stubMapInit();
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, JSON.stringify({ version: 1, selectedIds: [], layers: {} }));
    const handle = openMapTools(trips);
    handles.push(handle);
    const hover = vi.spyOn(TrackMap.prototype, 'showHover').mockImplementation(() => {});
    const input = handle.box.querySelector('.mt-coordinate-input') as HTMLInputElement;
    const datum = handle.box.querySelector('.mt-datum-select') as HTMLSelectElement;
    const original = { lat: 39.9042, lon: 116.4074 };
    const [lon, lat] = wgs84ToGcj02(original.lon, original.lat);
    input.value = `${lat}, ${lon}`;
    datum.value = 'GCJ02';
    datum.dispatchEvent(new Event('change', { bubbles: true }));
    handle.box.querySelector('.mt-coordinate-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(hover).toHaveBeenCalledWith(expect.closeTo(original.lat, 6), expect.closeTo(original.lon, 6), 'mapTools.coordinatePin');
    expect(mocks.resolveAltitude).not.toHaveBeenCalled();
    expect(handle.box.querySelector('.mt-network-note')?.textContent).toBe('mapTools.elevationDisclosure');

    (handle.box.querySelector('.mt-elevation-query .btn') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(handle.box.querySelector('.mt-elevation-result')?.textContent).toContain('123.4 m'));
    expect(mocks.resolveAltitude).toHaveBeenCalledWith(expect.closeTo(original.lat, 6), expect.closeTo(original.lon, 6), null, null);
    expect(handle.box.querySelector('.mt-elevation-result')?.textContent).toContain('mapTools.sourceService');
  });
});
