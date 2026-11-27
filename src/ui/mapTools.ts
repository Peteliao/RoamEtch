import { TrackMap } from './map';
import { el, icon, modal } from './helpers';
import { routeRepository } from '../core/routeRepository';
import { simplifyAsync } from '../core/workerBridge';
import { resolveAltitude } from '../core/elevation';
import { haversine, mergeWgs84Bounds, wgs84TrackBounds } from '../core/geo';
import { fromDisplay } from '../core/coords';
import { t } from '../core/i18n';

export const MAP_TOOLS_STORAGE_KEY = 'roametch.mapTools.v1';
export const MAP_TOOLS_SIMPLIFY_TOLERANCE_M = 5;
export const MAP_TOOLS_MAX_OVERLAY_TRACKS = 8;
export const MAP_TOOLS_MAX_POINTS_PER_TRACK = 20_000;

const LAYER_COLORS = ['#2bcda7', '#5aa7f0', '#f5b942', '#c792ea', '#ef6b55', '#68d391', '#f78fa3', '#8ca6c8'];
const MAX_TRACK_LOADS = 3;

export type MapToolsCoordinateSystem = 'WGS84' | 'GCJ02';

export interface MapToolsLayerPreference {
  selected: boolean;
  visible: boolean;
  color: string;
  opacity: number;
  slope: boolean;
}

export interface MapToolsPreferences {
  version: 1;
  selectedIds: string[];
  order: string[];
  layers: Record<string, MapToolsLayerPreference>;
}

export interface MapToolsTrackPoint {
  lat: number;
  lon: number;
  alt?: number | null;
  [key: string]: any;
}

export interface PreparedMapTrack {
  id: string;
  name: string;
  segments: Array<{ points: MapToolsTrackPoint[]; slopes: Array<number | null> }>;
  bbox: [number, number, number, number] | null;
  pointCount: number;
  pointLimited: boolean;
  hasAltitude: boolean;
}

interface RuntimeLayer extends MapToolsLayerPreference {
  id: string;
  status: 'idle' | 'loading' | 'ready' | 'error' | 'deferred';
}

export interface MapToolsHandle {
  close: () => void;
  box: HTMLElement;
  backdrop: HTMLElement;
  map: TrackMap;
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

function normalizeOpacity(value: unknown, fallback = 0.82) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0.15, value))
    : fallback;
}

function finishedTrips(trips: readonly any[]) {
  const seen = new Set<string>();
  return (Array.isArray(trips) ? trips : []).filter((trip) => {
    if (!trip || trip.status !== 'finished' || trip.id == null) return false;
    const id = String(trip.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Allow-list persisted fields and trip IDs; geometry and unknown data are discarded. */
export function normalizeMapToolsPreferences(value: unknown, trips: readonly any[]): MapToolsPreferences {
  const list = finishedTrips(trips);
  const validIds = list.map((trip) => String(trip.id));
  const valid = new Set(validIds);
  const raw = value && typeof value === 'object' ? value as any : {};
  const selected = new Set(
    Array.isArray(raw.selectedIds)
      ? raw.selectedIds.filter((id: unknown) => typeof id === 'string' && valid.has(id))
      : []
  );
  const order: string[] = [];
  const seenOrder = new Set<string>();
  for (const id of Array.isArray(raw.order) ? raw.order : []) {
    if (typeof id !== 'string' || !valid.has(id) || seenOrder.has(id)) continue;
    seenOrder.add(id);
    order.push(id);
  }
  for (const id of validIds) {
    if (!seenOrder.has(id)) order.push(id);
  }
  const layers: Record<string, MapToolsLayerPreference> = {};
  validIds.forEach((id, index) => {
    const saved = raw.layers && typeof raw.layers === 'object' && Object.hasOwn(raw.layers, id)
      ? raw.layers[id] || {}
      : {};
    layers[id] = {
      selected: selected.has(id),
      visible: typeof saved.visible === 'boolean' ? saved.visible : true,
      color: isHexColor(saved.color) ? saved.color.toLowerCase() : LAYER_COLORS[index % LAYER_COLORS.length],
      opacity: normalizeOpacity(saved.opacity),
      slope: typeof saved.slope === 'boolean' ? saved.slope : false
    };
  });
  return { version: 1, selectedIds: validIds.filter((id) => selected.has(id)), order, layers };
}

export function serializeMapToolsPreferences(layers: ReadonlyMap<string, MapToolsLayerPreference>) {
  const selectedIds: string[] = [];
  const order: string[] = [];
  const storedLayers: Record<string, Omit<MapToolsLayerPreference, 'selected'>> = {};
  for (const [id, layer] of layers) {
    if (layer.selected) selectedIds.push(id);
    order.push(id);
    storedLayers[id] = {
      visible: layer.visible,
      color: layer.color,
      opacity: layer.opacity,
      slope: layer.slope
    };
  }
  return JSON.stringify({ version: 1, selectedIds, order, layers: storedLayers });
}

export function loadMapToolsPreferences(trips: readonly any[]): MapToolsPreferences {
  let raw: unknown = null;
  try {
    const stored = localStorage.getItem(MAP_TOOLS_STORAGE_KEY);
    if (stored) raw = JSON.parse(stored);
  } catch { /* storage unavailable or corrupt */ }
  const preferences = normalizeMapToolsPreferences(raw, trips);
  const ids = finishedTrips(trips).map((trip) => String(trip.id));
  if (raw == null && ids.length) {
    preferences.selectedIds = [ids[0]];
    preferences.layers[ids[0]].selected = true;
  }
  return preferences;
}

export function saveMapToolsPreferences(layers: ReadonlyMap<string, MapToolsLayerPreference>) {
  try {
    localStorage.setItem(MAP_TOOLS_STORAGE_KEY, serializeMapToolsPreferences(layers));
  } catch { /* storage unavailable */ }
}

/** Parse decimal latitude,longitude in the selected datum and return WGS-84. */
export function parseWgs84Coordinate(input: string, coordSystem: MapToolsCoordinateSystem): { lat: number; lon: number } | null {
  const parts = String(input || '').trim().split(/[\s,，;；]+/).filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(part))) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const [wgsLon, wgsLat] = fromDisplay(lon, lat, coordSystem);
  if (!Number.isFinite(wgsLon) || !Number.isFinite(wgsLat)) return null;
  return { lat: wgsLat, lon: wgsLon };
}

export function altitudeSourceKey(source: unknown) {
  return source === 'gps' ? 'mapTools.sourceGps'
    : source === 'cache' ? 'mapTools.sourceCache'
      : source === 'svc' ? 'mapTools.sourceService'
        : 'mapTools.sourceUnavailable';
}

/**
 * Grade (%) for each edge starting at a point. Only adjacent, finite recorded
 * altitudes and non-zero horizontal distance are used; no gaps are bridged.
 */
export function computeSegmentSlopes(points: readonly MapToolsTrackPoint[]): Array<number | null> {
  const list = Array.isArray(points) ? points : [];
  const slopes: Array<number | null> = list.map(() => null);
  for (let i = 0; i < list.length - 1; i++) {
    const from = list[i];
    const to = list[i + 1];
    if (!Number.isFinite(from?.alt) || !Number.isFinite(to?.alt)) continue;
    const distance = haversine(from.lat, from.lon, to.lat, to.lon);
    if (!Number.isFinite(distance) || distance <= 0) continue;
    const slope = ((to.alt - from.alt) / distance) * 100;
    slopes[i] = Number.isFinite(slope) ? slope : null;
  }
  return slopes;
}

function validPoints(points: unknown): MapToolsTrackPoint[] {
  return (Array.isArray(points) ? points : []).filter((point) => point
    && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

function samplePoints(points: MapToolsTrackPoint[], limit: number) {
  if (points.length <= limit) return points;
  if (limit < 2) return [];
  return Array.from({ length: limit }, (_, index) =>
    points[Math.round(index * (points.length - 1) / (limit - 1))]);
}

/** Load-independent preparation used by the modal and directly exercised by tests. */
export async function prepareMapTrack(full: any, {
  signal,
  tolerance = MAP_TOOLS_SIMPLIFY_TOLERANCE_M,
  maxPoints = MAP_TOOLS_MAX_POINTS_PER_TRACK
}: { signal?: AbortSignal; tolerance?: number; maxPoints?: number } = {}): Promise<PreparedMapTrack | null> {
  if (!full?.trip || !Array.isArray(full.segments)) return null;
  const pointBudget = Math.max(0, Math.floor(maxPoints));
  const segments: PreparedMapTrack['segments'] = [];
  let pointCount = 0;
  let pointLimited = false;
  for (const segment of full.segments) {
    throwIfAborted(signal);
    const points = validPoints(segment?.points);
    if (points.length < 2) continue;
    const simplified = points.length > 2
      ? await simplifyAsync(points, tolerance, { signal })
      : points.slice();
    throwIfAborted(signal);
    const valid = validPoints(simplified);
    if (valid.length < 2) continue;
    const remaining = pointBudget - pointCount;
    if (remaining < 2) {
      pointLimited = true;
      break;
    }
    const prepared = samplePoints(valid, remaining);
    if (prepared.length < valid.length) pointLimited = true;
    segments.push({ points: prepared, slopes: computeSegmentSlopes(prepared) });
    pointCount += prepared.length;
  }
  throwIfAborted(signal);
  return {
    id: String(full.trip.id),
    name: String(full.trip.name || '').trim(),
    segments,
    bbox: wgs84TrackBounds(segments),
    pointCount,
    pointLimited,
    hasAltitude: segments.some((segment) => segment.slopes.some((slope) => slope != null))
  };
}

let activeMapTools: MapToolsHandle | null = null;

export function openMapTools(trips: readonly any[]): MapToolsHandle {
  activeMapTools?.close();
  const list = finishedTrips(trips);
  const preferences = loadMapToolsPreferences(list);
  const layers = new Map<string, RuntimeLayer>();
  const rows = new Map<string, ReturnType<typeof createLayerRow>>();
  const cache = new Map<string, PreparedMapTrack>();
  let focusedId = '';
  let destroyed = false;
  let overlaySequence = 0;
  let elevationSequence = 0;
  let loadController: AbortController | null = null;
  let resizeFrame = 0;

  for (const id of preferences.order) {
    const trip = list.find((candidate) => String(candidate.id) === id);
    if (trip) layers.set(id, { id, ...preferences.layers[id], status: 'idle' });
  }

  const layerList = el('div', { class: 'mt-layer-list', role: 'list' });
  const selectionSummary = el('span', { class: 'mt-selection-summary' });
  const mapCaption = el('span', { class: 'mt-map-caption-text', role: 'status', 'aria-live': 'polite' });
  const fitButton = el('button', { class: 'btn sm ghost', disabled: true, onclick: () => fitAllVisible() },
    icon('fit', 15), t('mapTools.fitAll'));
  const slopeLegend = el('div', { class: 'mt-slope-legend', hidden: true },
    el('span', { class: 'mt-slope-down' }, t('mapTools.descent')),
    el('span', { class: 'mt-slope-flat' }, t('mapTools.level')),
    el('span', { class: 'mt-slope-up' }, t('mapTools.ascent')));

  const mapContainer = el('div', { class: 'mt-map' });
  const trackMap = new TrackMap(mapContainer, {
    onOverlayTrackClick: (properties: any) => identifyTrip(properties?.tripId ?? properties?.id),
    onElevationPick: (lon: number, lat: number) => handlePickedCoordinate(lat, lon)
  });

  function persist() {
    saveMapToolsPreferences(layers);
  }

  function visibleLayers() {
    return [...layers.values()].filter((layer) => layer.selected && layer.visible);
  }

  function renderableLayers() {
    return visibleLayers().slice(0, MAP_TOOLS_MAX_OVERLAY_TRACKS);
  }

  function preparedTracks() {
    return renderableLayers().flatMap((layer) => {
      const prepared = cache.get(layer.id);
      if (!prepared) return [];
      return [{
        id: layer.id,
        name: prepared.name || tripName(list.find((trip) => String(trip.id) === layer.id)),
        color: layer.color,
        opacity: layer.opacity,
        slope: layer.slope,
        visible: true,
        segments: prepared.segments.map((segment) => ({
          points: segment.points,
          slopes: layer.slope ? segment.slopes : null
        }))
      }];
    });
  }

  function paintOverlays() {
    if (destroyed) return;
    trackMap.setOverlayTracks(preparedTracks());
    const visible = visibleLayers();
    const renderable = renderableLayers();
    fitButton.disabled = !renderable.some((layer) => cache.get(layer.id)?.bbox);
    slopeLegend.hidden = !renderable.some((layer) => layer.slope && cache.get(layer.id)?.hasAltitude);
    const loading = renderable.filter((layer) => layer.status === 'loading').length;
    if (focusedId && layers.has(focusedId)) {
      mapCaption.textContent = t('mapTools.clicked', { name: tripName(list.find((trip) => String(trip.id) === focusedId)) });
    } else if (loading) {
      mapCaption.textContent = t('mapTools.loadingCount', { n: loading });
    } else if (visible.length > renderable.length) {
      mapCaption.textContent = t('mapTools.overlayLimit', { n: renderable.length, total: visible.length - renderable.length });
    } else if (visible.length) {
      mapCaption.textContent = t('mapTools.overlayCount', { n: visible.length });
    } else {
      mapCaption.textContent = t('mapTools.noOverlays');
    }
  }

  function fitAllVisible() {
    if (destroyed) return;
    const bbox = mergeWgs84Bounds(renderableLayers().flatMap((layer) => {
      const next = cache.get(layer.id)?.bbox;
      return next ? [next] : [];
    }));
    if (!bbox) return;
    if (bbox[0] === bbox[2] && bbox[1] === bbox[3]) trackMap.flyTo(bbox[1], bbox[0], 15);
    else trackMap.fitWgs84Bounds(bbox, 44);
  }

  function identifyTrip(tripId: unknown) {
    if (destroyed || tripId == null) return;
    const id = String(tripId);
    const layer = layers.get(id);
    if (!layer) return;
    focusedId = id;
    for (const [rowId, row] of rows) {
      const focused = rowId === id;
      row.root.classList.toggle('is-focused', focused);
      if (focused) row.root.setAttribute('aria-current', 'true');
      else row.root.removeAttribute('aria-current');
    }
    paintOverlays();
    rows.get(id)?.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function updateRow(layer: RuntimeLayer) {
    const row = rows.get(layer.id);
    if (!row) return;
    row.root.classList.toggle('is-selected', layer.selected);
    row.select.checked = layer.selected;
    row.controls.hidden = !layer.selected;
    row.visibility.checked = layer.visible;
    row.visibility.disabled = !layer.selected;
    row.color.value = layer.color;
    row.colorDot.style.background = layer.color;
    row.opacity.value = String(Math.round(layer.opacity * 100));
    row.opacityOutput.textContent = `${Math.round(layer.opacity * 100)}%`;
    row.slope.checked = layer.slope;
    row.retry.hidden = layer.status !== 'error';
    row.root.dataset.status = layer.status;
    row.status.className = 'mt-layer-status';
    if (!layer.selected) row.status.textContent = '';
    else if (layer.status === 'loading') row.status.textContent = t('mapTools.loadingTrack');
    else if (layer.status === 'error') {
      row.status.textContent = t('mapTools.loadError');
      row.status.classList.add('is-error');
    } else if (layer.status === 'deferred') {
      row.status.textContent = t('mapTools.deferredTrack', { n: MAP_TOOLS_MAX_OVERLAY_TRACKS });
    } else if (layer.status === 'ready') {
      const prepared = cache.get(layer.id);
      row.status.textContent = prepared?.pointCount
        ? t('mapTools.readyPoints', { n: prepared.pointCount })
        : t('mapTools.noTrack');
      if (prepared?.pointLimited) {
        row.status.textContent += ' · ' + t('mapTools.pointLimit', { n: MAP_TOOLS_MAX_POINTS_PER_TRACK });
      }
      if (layer.slope && prepared && !prepared.hasAltitude) {
        row.status.textContent += ' · ' + t('mapTools.noAltitude');
      }
    } else row.status.textContent = t('mapTools.readyToLoad');
  }

  function updateOrderButtons() {
    const ids = [...layers.keys()];
    for (const [id, row] of rows) {
      const index = ids.indexOf(id);
      row.up.disabled = index <= 0;
      row.down.disabled = index < 0 || index >= ids.length - 1;
    }
  }

  function moveLayer(id: string, delta: number) {
    const entries = [...layers.entries()];
    const index = entries.findIndex(([key]) => key === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= entries.length) return;
    const [entry] = entries.splice(index, 1);
    entries.splice(target, 0, entry);
    layers.clear();
    for (const [key, value] of entries) layers.set(key, value);
    layerList.replaceChildren(...[...layers.keys()].map((key) => rows.get(key)?.root).filter(Boolean));
    persist();
    updateAllRows();
  }

  function updateAllRows() {
    const selected = [...layers.values()].filter((layer) => layer.selected).length;
    selectionSummary.textContent = t('mapTools.selectedCount', { n: selected, total: layers.size });
    for (const layer of layers.values()) updateRow(layer);
    updateOrderButtons();
    paintOverlays();
  }

  async function refreshOverlays() {
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    const sequence = ++overlaySequence;
    const desired = renderableLayers();
    const desiredIds = new Set(desired.map((layer) => layer.id));
    for (const id of cache.keys()) {
      if (!desiredIds.has(id)) cache.delete(id);
    }
    for (const layer of layers.values()) {
      if (!layer.selected || !layer.visible) {
        if (layer.status !== 'error') layer.status = 'idle';
      } else if (!desiredIds.has(layer.id)) {
        layer.status = 'deferred';
      } else if (cache.has(layer.id)) {
        layer.status = 'ready';
      } else if (layer.status !== 'error') {
        layer.status = 'loading';
      }
    }
    updateAllRows();
    if (!desired.length) return;

    let cursor = 0;
    const worker = async () => {
      while (!destroyed && !controller.signal.aborted && cursor < desired.length) {
        const layer = desired[cursor++];
        if (cache.has(layer.id)) continue;
        try {
          const track = await routeRepository.load(layer.id);
          if (destroyed || controller.signal.aborted || sequence !== overlaySequence) return;
          if (!track) throw new Error('Trip unavailable');
          const prepared = await prepareMapTrack(track, { signal: controller.signal });
          if (destroyed || controller.signal.aborted || sequence !== overlaySequence) return;
          if (!prepared) throw new Error('Track unavailable');
          cache.set(layer.id, prepared);
          layer.status = 'ready';
        } catch {
          if (destroyed || controller.signal.aborted || sequence !== overlaySequence) return;
          layer.status = 'error';
        } finally {
          if (!destroyed && !controller.signal.aborted && sequence === overlaySequence) updateRow(layer);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_TRACK_LOADS, desired.length) }, worker));
    if (destroyed || controller.signal.aborted || sequence !== overlaySequence) return;
    paintOverlays();
    fitAllVisible();
  }

  function tripName(trip: any) {
    return String(trip?.name || '').trim() || t('mapTools.untitled');
  }

  function createLayerRow(trip: any, layer: RuntimeLayer) {
    const colorDot = el('span', { class: 'mt-color-dot', 'aria-hidden': 'true' });
    const select = el('input', { type: 'checkbox', 'aria-label': `${t('mapTools.selectTrack')}: ${tripName(trip)}` });
    const visibility = el('input', { type: 'checkbox', 'aria-label': `${t('mapTools.visibility')}: ${tripName(trip)}` });
    const color = el('input', { type: 'color', 'aria-label': `${t('mapTools.color')}: ${tripName(trip)}` });
    const opacity = el('input', {
      type: 'range', min: '15', max: '100', step: '1',
      'aria-label': `${t('mapTools.opacity')}: ${tripName(trip)}`
    });
    const opacityOutput = el('output', { class: 'mt-opacity-value' });
    const slope = el('input', { type: 'checkbox', 'aria-label': `${t('mapTools.slope')}: ${tripName(trip)}` });
    const up = el('button', {
      type: 'button', class: 'mt-order-button', title: t('mapTools.moveUp'), disabled: true,
      'aria-label': `${t('mapTools.moveUp')}: ${tripName(trip)}`,
      onclick: () => moveLayer(layer.id, -1)
    }, '↑');
    const down = el('button', {
      type: 'button', class: 'mt-order-button', title: t('mapTools.moveDown'), disabled: true,
      'aria-label': `${t('mapTools.moveDown')}: ${tripName(trip)}`,
      onclick: () => moveLayer(layer.id, 1)
    }, '↓');
    const status = el('span', { class: 'mt-layer-status' });
    const retry = el('button', {
      class: 'btn sm ghost', hidden: true,
      onclick: () => { layer.status = 'idle'; updateRow(layer); void refreshOverlays(); }
    }, t('common.retry'));
    const controls = el('div', { class: 'mt-layer-controls', hidden: true },
      el('div', { class: 'mt-control-grid' },
        el('label', { class: 'mt-color-field' }, el('span', {}, t('mapTools.color')), color),
        el('label', { class: 'mt-opacity-field' },
          el('span', { class: 'mt-control-label' }, t('mapTools.opacity'), opacityOutput), opacity)),
      el('div', { class: 'mt-switch-row' },
        el('span', {}, t('mapTools.visibility')),
        el('label', { class: 'switch' }, visibility, el('span', { class: 'slider' }))),
      el('div', { class: 'mt-switch-row' },
        el('span', {}, t('mapTools.slope')),
        el('label', { class: 'switch' }, slope, el('span', { class: 'slider' }))),
      el('p', { class: 'mt-slope-hint' }, t('mapTools.slopeHint')),
      retry);
    const date = Number.isFinite(trip.createdAt) && trip.createdAt > 0
      ? new Date(trip.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
      : '';
    const root = el('div', { class: 'mt-layer', role: 'listitem', 'data-trip-id': layer.id },
      el('div', { class: 'mt-layer-head' },
        el('label', { class: 'mt-layer-select' }, select, colorDot,
          el('span', { class: 'mt-layer-copy' },
            el('strong', {}, tripName(trip)),
            date ? el('small', {}, date) : null)),
        el('div', { class: 'mt-layer-side' },
          el('div', { class: 'mt-order-controls' }, up, down),
          status)),
      controls);
    select.addEventListener('change', () => {
      layer.selected = select.checked;
      persist();
      updateAllRows();
      void refreshOverlays();
    });
    visibility.addEventListener('change', () => {
      layer.visible = visibility.checked;
      persist();
      updateAllRows();
      void refreshOverlays();
    });
    color.addEventListener('input', () => {
      layer.color = isHexColor(color.value) ? color.value.toLowerCase() : layer.color;
      persist();
      updateRow(layer);
      paintOverlays();
    });
    opacity.addEventListener('input', () => {
      layer.opacity = normalizeOpacity(Number(opacity.value) / 100);
      persist();
      updateRow(layer);
      paintOverlays();
    });
    slope.addEventListener('change', () => {
      layer.slope = slope.checked;
      persist();
      updateRow(layer);
      paintOverlays();
    });
    return { root, select, visibility, color, colorDot, opacity, opacityOutput, slope, controls, status, retry, up, down };
  }

  if (!list.length) {
    layerList.append(el('div', { class: 'mt-empty' }, icon('map', 26),
      el('strong', {}, t('mapTools.noTrips')), el('span', {}, t('mapTools.noTripsHint'))));
  } else {
    for (const id of layers.keys()) {
      const trip = list.find((candidate) => String(candidate.id) === id)!;
      const layer = layers.get(id)!;
      const row = createLayerRow(trip, layer);
      rows.set(layer.id, row);
      layerList.append(row.root);
    }
  }

  const coordinateInput = el('input', {
    class: 'mt-coordinate-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
    placeholder: t('mapTools.coordinatePlaceholder'), 'aria-describedby': 'mt-coordinate-help mt-coordinate-message'
  });
  const datumSelect = el('select', { class: 'mt-datum-select', 'aria-label': t('mapTools.datum') },
    el('option', { value: 'WGS84' }, 'WGS-84'),
    el('option', { value: 'GCJ02' }, 'GCJ-02'));
  const coordinateMessage = el('p', { class: 'mt-coordinate-message', id: 'mt-coordinate-message', role: 'status', 'aria-live': 'polite' });
  const elevationResult = el('div', { class: 'mt-elevation-result', role: 'status', 'aria-live': 'polite' });
  const elevationButton = el('button', { class: 'btn sm primary', type: 'button' },
    icon('mountain', 15), t('mapTools.queryElevation'));
  let pickActive = false;
  const pickButton = el('button', {
    class: 'btn sm ghost mt-pick-button', type: 'button', title: t('mapTools.pickHint'),
    'aria-pressed': 'false', onclick: () => setPickActive(!pickActive)
  }, icon('pin', 15), t('mapTools.pickOnMap'));

  function setPickActive(on: boolean) {
    pickActive = !!on;
    pickButton.setAttribute('aria-pressed', pickActive ? 'true' : 'false');
    pickButton.classList.toggle('is-active', pickActive);
    trackMap.setElevationPickMode(pickActive);
    if (pickActive) {
      coordinateMessage.classList.remove('is-error');
      coordinateMessage.textContent = t('mapTools.pickActive');
    } else if (coordinateMessage.textContent === t('mapTools.pickActive')) {
      coordinateMessage.textContent = '';
    }
  }

  function handlePickedCoordinate(lat: number, lon: number) {
    if (destroyed || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    datumSelect.value = 'WGS84';
    coordinateInput.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    coordinateInput.removeAttribute('aria-invalid');
    coordinateMessage.classList.remove('is-error');
    invalidateElevation();
    coordinateMessage.textContent = t('mapTools.pickedCoordinate', {
      lat: lat.toFixed(6), lon: lon.toFixed(6)
    });
    trackMap.showHover(lat, lon, t('mapTools.coordinatePin'));
    setPickActive(false);
  }

  function invalidateElevation() {
    elevationSequence++;
    elevationButton.disabled = false;
    elevationButton.replaceChildren(icon('mountain', 15), t('mapTools.queryElevation'));
    elevationResult.replaceChildren();
    elevationResult.className = 'mt-elevation-result';
  }

  function readCoordinate() {
    const coordinate = parseWgs84Coordinate(coordinateInput.value, datumSelect.value as MapToolsCoordinateSystem);
    if (!coordinate) {
      coordinateInput.setAttribute('aria-invalid', 'true');
      coordinateMessage.textContent = t('mapTools.invalidCoordinate');
      coordinateMessage.classList.add('is-error');
      return null;
    }
    coordinateInput.removeAttribute('aria-invalid');
    coordinateMessage.classList.remove('is-error');
    return coordinate;
  }

  coordinateInput.addEventListener('input', () => {
    coordinateInput.removeAttribute('aria-invalid');
    coordinateMessage.textContent = '';
    coordinateMessage.classList.remove('is-error');
    invalidateElevation();
  });
  datumSelect.addEventListener('change', () => {
    coordinateMessage.textContent = '';
    coordinateMessage.classList.remove('is-error');
    invalidateElevation();
  });

  const coordinateForm = el('form', {
    class: 'mt-coordinate-form',
    onsubmit: (event: Event) => {
      event.preventDefault();
      setPickActive(false);
      const coordinate = readCoordinate();
      if (!coordinate) return;
      trackMap.showHover(coordinate.lat, coordinate.lon, t('mapTools.coordinatePin'));
      trackMap.flyTo(coordinate.lat, coordinate.lon, 16);
      coordinateMessage.textContent = t('mapTools.located', {
        lat: coordinate.lat.toFixed(6), lon: coordinate.lon.toFixed(6)
      });
    }
  },
  el('label', { class: 'mt-section-label', for: 'mt-coordinate-input' }, t('mapTools.coordinateLabel')),
  el('div', { class: 'mt-coordinate-controls' },
    coordinateInput,
    datumSelect,
    el('button', { class: 'btn sm ghost mt-fly-button', type: 'submit' }, icon('pin', 15), t('mapTools.flyTo'))),
  el('div', { class: 'mt-pick-row' }, pickButton),
  el('p', { class: 'mt-help', id: 'mt-coordinate-help' }, t('mapTools.coordinateHint')),
  coordinateMessage);
  coordinateInput.id = 'mt-coordinate-input';

  elevationButton.addEventListener('click', async () => {
    const coordinate = readCoordinate();
    if (!coordinate) return;
    const sequence = ++elevationSequence;
    elevationButton.disabled = true;
    elevationButton.replaceChildren(icon('mountain', 15), t('mapTools.querying'));
    elevationResult.className = 'mt-elevation-result is-loading';
    elevationResult.textContent = t('mapTools.querying');
    try {
      const result = await resolveAltitude(coordinate.lat, coordinate.lon, null, null);
      if (destroyed || sequence !== elevationSequence) return;
      const available = result?.alt != null && Number.isFinite(result.alt);
      const value = available
        ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(result.alt)
        : '--';
      elevationResult.className = 'mt-elevation-result';
      elevationResult.replaceChildren(
        el('strong', {}, `${value} m`),
        el('span', {}, `${t('mapTools.source')}: ${t(altitudeSourceKey(result?.src))}`));
    } catch {
      if (destroyed || sequence !== elevationSequence) return;
      elevationResult.className = 'mt-elevation-result is-error';
      elevationResult.replaceChildren(
        el('strong', {}, '-- m'),
        el('span', {}, `${t('mapTools.source')}: ${t('mapTools.sourceUnavailable')}`),
        el('small', {}, t('mapTools.elevationError')));
    } finally {
      if (!destroyed && sequence === elevationSequence) {
        elevationButton.disabled = false;
        elevationButton.replaceChildren(icon('mountain', 15), t('mapTools.queryElevation'));
      }
    }
  });

  const layersPanel = el('section', { class: 'mt-panel mt-layers-panel', 'aria-labelledby': 'mt-layers-title' },
    el('div', { class: 'mt-panel-head' },
      el('h4', { id: 'mt-layers-title' }, t('mapTools.tracks')),
      selectionSummary),
    el('div', { class: 'mt-selection-actions' },
      el('button', {
        class: 'btn sm ghost', onclick: () => {
          for (const layer of layers.values()) layer.selected = true;
          persist(); updateAllRows(); void refreshOverlays();
        }
      }, t('mapTools.selectAll')),
      el('button', {
        class: 'btn sm ghost', onclick: () => {
          for (const layer of layers.values()) layer.selected = false;
          persist(); updateAllRows(); void refreshOverlays();
        }
      }, t('mapTools.selectNone'))),
    layerList,
    el('p', { class: 'mt-privacy-note' }, t('mapTools.privacyNote')));

  const coordinatesPanel = el('section', { class: 'mt-panel', 'aria-labelledby': 'mt-coordinates-title' },
    el('h4', { id: 'mt-coordinates-title' }, t('mapTools.coordinates')),
    coordinateForm,
    el('div', { class: 'mt-elevation-query' },
      elevationButton,
      el('p', { class: 'mt-network-note' }, t('mapTools.elevationDisclosure'))),
    elevationResult);

  const body = el('div', { class: 'map-tools-modal' },
    el('aside', { class: 'mt-sidebar' }, layersPanel, coordinatesPanel),
    el('div', { class: 'mt-map-pane' },
      el('div', { class: 'mt-map-toolbar' },
        el('div', { class: 'mt-map-caption' }, el('span', { class: 'mt-live-dot', 'aria-hidden': 'true' }), mapCaption),
        fitButton),
      mapContainer,
      slopeLegend,
      el('p', { class: 'mt-map-note' }, t('mapTools.segmentNote'))));

  const cleanup = () => {
    if (destroyed) return;
    destroyed = true;
    overlaySequence++;
    elevationSequence++;
    loadController?.abort();
    loadController = null;
    cancelAnimationFrame(resizeFrame);
    persist();
    cache.clear();
    trackMap.setElevationPickMode(false);
    trackMap.destroy();
    if (activeMapTools?.map === trackMap) activeMapTools = null;
  };

  const dialog = modal({
    title: t('mapTools.title'),
    body,
    wide: true,
    onClose: cleanup
  });
  dialog.box.classList.add('map-tools-dialog');
  dialog.box.style.maxWidth = '1120px';
  const handle: MapToolsHandle = { close: dialog.close, box: dialog.box, backdrop: dialog.backdrop, map: trackMap };
  activeMapTools = handle;
  trackMap.init([116.4, 39.9], 4);
  resizeFrame = requestAnimationFrame(() => trackMap.resize());
  void refreshOverlays();
  return handle;
}
