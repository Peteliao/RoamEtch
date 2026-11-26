// MapLibre wrapper: profile-driven basemaps, WGS-84 storage with render-time
// GCJ-02 adaptation, incremental live track, waypoint/vertex editing, vector fallback.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { toDisplay, fromDisplay } from '../core/coords';
import { getBasemap, buildRasterStyle, buildVectorStyle, availableBasemaps, defaultBasemapId, vectorBgColor } from '../core/providers';
import { isOfflineSim, regionState } from '../core/region';
import { simplify, haversine } from '../core/geo';
import { on, emit } from '../core/events';
import { diag } from '../core/diag';
import { t } from '../core/i18n';
import { WP_ICONS } from '../core/waypointMeta';
import { meetProximityZoom, meetRoleColor } from '../core/meetVisuals';

const LIVE_FILL = 'rgba(90,167,240,0.14)';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

function cssVar(name: string, fallback: string) {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export class TrackMap {
  declare container: HTMLElement;
  declare opts: any;
  declare coordSystem: string;
  declare basemapId: string | null;
  declare segments: any[];
  declare splitParts: any[];
  declare waypoints: any[];
  declare editMode: boolean;
  declare follow: boolean;
  declare liveMode: boolean;
  declare wpMarkers: Map<any, any>;
  declare cityMarkers: any[];
  declare vertexMarkers: any[];
  declare posMarker: any;
  declare hoverMarker: any;
  declare navMarker: any;
  declare photoRefMarker: any;
  declare meetMarkers: Map<string, any>;
  declare meetSelf: any;
  declare meetPeers: any[];
  declare meetRoute: any;
  declare tileErrors: number;
  declare tileLoaded: boolean;
  declare vectorFallback: boolean;
  declare _indexMaps: Map<string, any>;
  declare _moveTimer: any;
  declare destroyed: boolean;
  declare _renderingPaused: boolean;
  declare _pausedRepaintDescriptor: PropertyDescriptor | undefined;
  declare map: any;
  declare _offRegion: any;
  declare _offProbe: any;
  declare _offTheme: any;
  declare _onOnline: (() => void) | null;
  declare _fallbackEl: HTMLElement | null;
  declare _liveZoomed: boolean;
  declare _liveFeats: Map<string, any> | null;
  declare _headingEl: HTMLElement | null;
  declare _meetAutoZoomReady: boolean;
  declare _meetManualCameraUntil: number;
  declare _meetLastDistance: number;
  declare _meetLastSelf: { lat: number; lon: number } | null;
  declare _meetCameraAnimating: boolean;
  declare _viewportOverlay: HTMLElement | null;
  declare _viewportObserver: ResizeObserver | null;
  declare _viewportFrame: number;
  declare _viewportBottom: number;

  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.coordSystem = 'WGS84';
    this.basemapId = null;
    this.segments = [];          // [{id, points}] WGS-84
    this.splitParts = [];
    this.waypoints = [];
    this.editMode = false;
    this.follow = false;
    this.liveMode = false;
    this.wpMarkers = new Map();
    this.cityMarkers = [];
    this.vertexMarkers = [];
    this.posMarker = null;
    this.hoverMarker = null;
    this.navMarker = null;
    this.photoRefMarker = null;
    this.meetMarkers = new Map();
    this.meetSelf = null;
    this.meetPeers = [];
    this.meetRoute = null;
    this.tileErrors = 0;
    this.tileLoaded = false;
    this.vectorFallback = false;
    this._indexMaps = new Map();
    this._moveTimer = null;
    this.destroyed = false;
    this._renderingPaused = false;
    this._pausedRepaintDescriptor = undefined;
    this._meetAutoZoomReady = false;
    this._meetManualCameraUntil = 0;
    this._meetLastDistance = Number.NaN;
    this._meetLastSelf = null;
    this._meetCameraAnimating = false;
    this._viewportOverlay = null;
    this._viewportObserver = null;
    this._viewportFrame = 0;
    this._viewportBottom = 0;
  }

  init(center = [116.4, 39.9], zoom = 10) {
    const offline = isOfflineSim();
    const provider = getBasemap(defaultBasemapId());
    this.basemapId = provider?.id || null;
    this.coordSystem = provider?.coordSystem || 'WGS84';
    this.vectorFallback = offline || !provider;
    this.map = new maplibregl.Map({
      container: this.container,
      style: (provider ? buildRasterStyle(provider) : buildVectorStyle()) as any,
      center: center as any, zoom,
      preserveDrawingBuffer: this.opts.preserveDrawingBuffer !== false,
      attributionControl: { compact: true },
      fadeDuration: 120,
      maxZoom: 20
    } as any);
    if (!this.opts.compact) {
      this.map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-right');
    }
    this.map.on('load', () => {
      this._addTrackLayers();
      this.redraw();
      if (this.vectorFallback) this._showFallbackBanner();
    });
    this.map.on('style.load', () => {
      this._addTrackLayers();
      this._applyTheme();
      this.redraw();
      requestAnimationFrame(() => this._updateMeetProximity());
    });
    this.map.on('error', (e) => {
      const msg = String(e?.error?.message || e?.message || '');
      if (/tile|fetch|network|Failed/i.test(msg)) {
        this.tileErrors++;
        if (this.tileErrors >= 8 && !this.tileLoaded && !this.vectorFallback) {
          diag('map', 'tile errors → vector fallback', { errors: this.tileErrors });
          this._enterVectorFallback();
        }
      } else if (msg) {
        diag('map', 'map error', { msg: msg.slice(0, 200) });
      }
    });
    this.map.on('sourcedata', (e) => {
      if (e.sourceId === 'base' && e.isSourceLoaded) this.tileLoaded = true;
    });
    this.map.on('moveend', () => {
      this._meetCameraAnimating = false;
      if (this.editMode) this._scheduleVertices();
      requestAnimationFrame(() => this._updateMeetProximity());
    });
    this.map.on('click', (e) => {
      if (!this.editMode) return;
      const [lon, lat] = fromDisplay(e.lngLat.lng, e.lngLat.lat, this.coordSystem);
      this.opts.onMapClick?.(lon, lat);
    });
    this.map.on('dragstart', () => {
      this.follow = false;
      this._meetManualCameraUntil = Date.now() + 12000;
      this._meetLastDistance = Number.NaN;
      this._meetCameraAnimating = false;
      emit('map:followoff');
    });
    this.map.on('wheel', () => {
      this._meetManualCameraUntil = Date.now() + 12000;
      this._meetLastDistance = Number.NaN;
    });
    this.map.on('zoomstart', () => {
      if (this.meetSelf && !this._meetCameraAnimating) this._meetManualCameraUntil = Date.now() + 12000;
    });
    this._offRegion = on('region:changed', () => { if (!this.liveMode) this.refreshBasemapForRegion(); });
    const recover = () => {
      if (!isOfflineSim() && (this.vectorFallback || (this.tileErrors > 0 && !this.tileLoaded))) {
        this.refreshBasemapForRegion();
      }
    };
    this._offProbe = on('region:probed', recover);
    this._onOnline = recover;
    window.addEventListener('online', recover);
    this._offTheme = on('theme:applied', () => this._applyTheme());
    return this;
  }

  observeViewportInset(overlay: HTMLElement | null) {
    this._viewportObserver?.disconnect();
    this._viewportOverlay = overlay;
    if (!overlay || typeof ResizeObserver === 'undefined') {
      this.setViewportInset(0);
      return;
    }
    const schedule = () => {
      cancelAnimationFrame(this._viewportFrame);
      this._viewportFrame = requestAnimationFrame(() => this.updateViewportInset());
    };
    this._viewportObserver = new ResizeObserver(schedule);
    this._viewportObserver.observe(overlay);
    this._viewportObserver.observe(this.container);
    schedule();
  }

  updateViewportInset() {
    const overlay = this._viewportOverlay;
    if (!this.map || this.destroyed || !overlay) return;
    const style = getComputedStyle(overlay);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && overlay.getClientRects().length > 0;
    const bottom = visible
      ? Math.max(0, this.container.getBoundingClientRect().bottom - overlay.getBoundingClientRect().top)
      : 0;
    this.setViewportInset(bottom);
  }

  setViewportInset(bottom: number) {
    if (!this.map || this.destroyed) return;
    const value = Math.max(0, Math.round(bottom));
    if (value === this._viewportBottom) return;
    this._viewportBottom = value;
    this.map.setPadding({ top: 0, right: 0, bottom: value, left: 0 });
  }

  // Basemap tiles stay full-color in every theme; track, gaps and background follow it.
  _applyTheme() {
    const m = this.map;
    if (!m || this.destroyed) return;
    const apply = () => {
      const set = (layer, prop, val) => { if (m.getLayer(layer)) m.setPaintProperty(layer, prop, val); };
      const accent = cssVar('--track', '#2bcda7');
      set('bg', 'background-color', vectorBgColor());
      set('pos-acc', 'fill-color', cssVar('--info', '#5aa7f0'));
      set('gap-line', 'line-color', cssVar('--track-gap', '#93a1ac'));
      set('track-casing', 'line-color', cssVar('--track-casing', '#06251d'));
      set('live-casing', 'line-color', cssVar('--track-casing', '#06251d'));
      set('meet-route-case', 'line-color', cssVar('--track-casing', '#06251d'));
      set('track-line', 'line-color', accent);
      set('split-highlight', 'line-color', cssVar('--warn', '#f2b14a'));
      set('live-line', 'line-color', accent);
      set('nav-line', 'line-color', cssVar('--warn', '#f2b14a'));
      set('meet-route-line', 'line-color', cssVar('--info', '#5aa7f0'));
    };
    if (m.isStyleLoaded()) apply();
    else m.once('style.load', apply);
  }

  refreshBasemapForRegion() {
    if (isOfflineSim()) {
      if (!this.vectorFallback) this._enterVectorFallback();
      return;
    }
    const list = availableBasemaps();
    if (!list.length) return;
    const keep = list.find((b) => b.id === this.basemapId);
    if (this.vectorFallback || (this.tileErrors > 0 && !this.tileLoaded)) {
      this.setBasemap(keep?.id || defaultBasemapId());
      return;
    }
    if (!keep) this.setBasemap(list[0].id);
  }

  setBasemap(id) {
    const provider = getBasemap(id);
    if (!provider) return;
    this.basemapId = id;
    this.coordSystem = provider.coordSystem;
    this.tileErrors = 0;
    this.tileLoaded = false;
    const offline = isOfflineSim();
    this.vectorFallback = offline;
    this.map.setStyle(offline ? buildVectorStyle() : buildRasterStyle(provider));
    this._hideFallbackBanner();
    if (offline) this._showFallbackBanner();
    emit('map:basemap', { id, coordSystem: this.coordSystem, offline });
    diag('map', 'basemap switched', { id, coordSystem: this.coordSystem });
  }

  _enterVectorFallback() {
    this.vectorFallback = true;
    this.map.setStyle(buildVectorStyle());
    this._showFallbackBanner();
    emit('map:fallback');
  }

  retryTiles() {
    const id = this.basemapId || defaultBasemapId();
    if (id) this.setBasemap(id);
  }

  _showFallbackBanner() {
    if (this.opts.compact) return;
    this._hideFallbackBanner();
    this._fallbackEl = document.createElement('div');
    this._fallbackEl.className = 'map-fallback';
    this._fallbackEl.style.pointerEvents = 'none';
    this._fallbackEl.style.background = 'transparent';
    this._fallbackEl.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'pointer-events:auto;background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:10px 14px;font-size:12.5px;color:var(--text-dim);position:absolute;top:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;white-space:nowrap';
    box.textContent = '⚠ ' + (this.opts.fallbackText || t('map.fallback'));
    const retry = document.createElement('button');
    retry.className = 'btn sm';
    retry.textContent = '↻';
    retry.onclick = () => this.retryTiles();
    box.append(retry);
    this._fallbackEl.append(box);
    this.container.append(this._fallbackEl);
  }
  _hideFallbackBanner() { this._fallbackEl?.remove(); this._fallbackEl = null; }

  _addTrackLayers() {
    const m = this.map;
    if (!m.getSource('track')) {
      m.addSource('track', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('gaps')) {
      m.addSource('gaps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('split-highlight')) {
      m.addSource('split-highlight', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('live')) {
      m.addSource('live', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('pos')) {
      m.addSource('pos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('nav')) {
      m.addSource('nav', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('meet-links')) {
      m.addSource('meet-links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('meet-route')) {
      m.addSource('meet-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    const accent = cssVar('--track', '#2bcda7');
    const casing = cssVar('--track-casing', '#06251d');
    if (!m.getLayer('pos-acc')) m.addLayer({ id: 'pos-acc', type: 'fill', source: 'pos', paint: { 'fill-color': cssVar('--info', '#5aa7f0'), 'fill-opacity': 0.12 } });
    if (!m.getLayer('gap-line')) m.addLayer({ id: 'gap-line', type: 'line', source: 'gaps', paint: { 'line-color': cssVar('--track-gap', '#93a1ac'), 'line-width': 1.6, 'line-dasharray': [2, 2.4], 'line-opacity': 0.65 } });
    if (!m.getLayer('track-casing')) m.addLayer({ id: 'track-casing', type: 'line', source: 'track', paint: { 'line-color': casing, 'line-width': 7, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('track-line')) m.addLayer({ id: 'track-line', type: 'line', source: 'track', paint: { 'line-color': accent, 'line-width': 4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('split-highlight')) m.addLayer({ id: 'split-highlight', type: 'line', source: 'split-highlight', paint: { 'line-color': cssVar('--warn', '#f2b14a'), 'line-width': 7, 'line-opacity': 0.9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('nav-line')) m.addLayer({ id: 'nav-line', type: 'line', source: 'nav', paint: { 'line-color': cssVar('--warn', '#f2b14a'), 'line-width': 3, 'line-opacity': 0.9, 'line-dasharray': [1.2, 1.6] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('live-casing')) m.addLayer({ id: 'live-casing', type: 'line', source: 'live', paint: { 'line-color': casing, 'line-width': 7, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('live-line')) m.addLayer({ id: 'live-line', type: 'line', source: 'live', paint: { 'line-color': accent, 'line-width': 4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('meet-link-line')) {
      m.addLayer({
        id: 'meet-link-line', type: 'line', source: 'meet-links',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], accent],
          'line-width': 2,
          'line-opacity': ['case', ['get', 'stale'], 0.35, 0.78],
          'line-dasharray': [2, 2.6]
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' }
      });
    }
    if (!m.getLayer('meet-route-case')) m.addLayer({ id: 'meet-route-case', type: 'line', source: 'meet-route', paint: { 'line-color': casing, 'line-width': 8, 'line-opacity': 0.65 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('meet-route-line')) m.addLayer({ id: 'meet-route-line', type: 'line', source: 'meet-route', paint: { 'line-color': cssVar('--info', '#5aa7f0'), 'line-width': 4.5, 'line-opacity': 0.95 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    this._applyMeetData();
  }

  /** segments: [{id, points:[{lat,lon,...}]}] in WGS-84 */
  setTrackData(segments, waypoints = []) {
    this.segments = segments;
    this.splitParts = [];
    this.waypoints = waypoints;
    this._indexMaps.clear();
    for (const s of segments) {
      const im = new Map();
      s.points.forEach((p, i) => im.set(p, i));
      this._indexMaps.set(s.id, im);
    }
    this.redraw();
  }

  _displayCoords(points) {
    return points.map((p) => toDisplay(p.lon, p.lat, this.coordSystem));
  }

  setSplitHighlight(parts, focus = false) {
    this.splitParts = Array.isArray(parts) ? parts : [];
    this._renderSplitHighlight();
    const coords: [number, number][] = this.splitParts
      .flatMap((part) => part.points || [])
      .map((p) => toDisplay(p.lon, p.lat, this.coordSystem) as [number, number]);
    if (focus && coords.length && this.map) {
      if (coords.length === 1) this.map.flyTo({ center: coords[0], zoom: 16, duration: 500 });
      else {
        const bounds = coords.reduce((all, coord) => all.extend(coord), new maplibregl.LngLatBounds());
        this.map.fitBounds(bounds, { padding: 42, maxZoom: 16, duration: 500 });
      }
    }
  }

  _renderSplitHighlight() {
    const features = this.splitParts
      .filter((part) => part.points?.length > 1)
      .map((part) => ({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: this._displayCoords(part.points) }
      }));
    this.map?.getSource('split-highlight')?.setData({ type: 'FeatureCollection', features });
  }

  redraw() {
    if (!this.map || this.destroyed) return;
    const doDraw = () => {
      const zoom = this.map.getZoom();
      const tol = Math.max(1.5, 360 / Math.pow(2, zoom) * 111320 / 256 * 1.2); // ~1.2 px in metres
      const feats = [];
      const gapFeats = [];
      let prevEnd = null;
      for (const seg of this.segments) {
        if (!seg.points.length) continue;
        const pts = seg.points.length > 400 ? simplify(seg.points, tol) : seg.points;
        const coords = this._displayCoords(pts);
        feats.push({ type: 'Feature', properties: { seg: seg.id }, geometry: { type: 'LineString', coordinates: coords } });
        const first = coords[0], last = coords[coords.length - 1];
        if (prevEnd) gapFeats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [prevEnd, first] } });
        prevEnd = last;
      }
      this.map.getSource('track')?.setData({ type: 'FeatureCollection', features: feats });
      this.map.getSource('gaps')?.setData({ type: 'FeatureCollection', features: gapFeats });
      this._renderSplitHighlight();
      this._renderWaypoints();
      if (this.editMode) this._scheduleVertices();
    };
    if (this.map.isStyleLoaded()) doDraw();
    else this.map.once('style.load', doDraw);
  }

  /** Repaint waypoint markers only (mid-recording adds, without resetting the live track). */
  setWaypoints(waypoints = []) {
    this.waypoints = waypoints;
    this._renderWaypoints();
  }

  setCityMarkers(cities = []) {
    for (const marker of this.cityMarkers) marker.remove();
    this.cityMarkers = [];
    if (!this.map) return;
    const bounds = new maplibregl.LngLatBounds();
    const maxTrips = Math.max(1, ...cities.map((city) => city.trips || 1));
    for (const city of cities) {
      const [lon, lat] = toDisplay(city.lon, city.lat, this.coordSystem);
      const node = document.createElement('button');
      node.className = 'city-footprint-marker';
      node.type = 'button';
      node.style.setProperty('--city-size', `${18 + Math.round((city.trips / maxTrips) * 10)}px`);
      const dot = document.createElement('i');
      const label = document.createElement('span');
      label.textContent = city.name;
      node.append(dot, label);
      node.setAttribute('aria-label', city.label || city.name);
      node.title = city.label || city.name;
      const marker = new maplibregl.Marker({ element: node }).setLngLat([lon, lat]);
      if (city.label) {
        marker.setPopup(new maplibregl.Popup({ offset: 22, closeButton: false }).setText(city.label));
        node.addEventListener('click', (e) => { e.stopPropagation(); marker.togglePopup(); });
      }
      marker.addTo(this.map);
      this.cityMarkers.push(marker);
      bounds.extend([lon, lat]);
    }
    if (cities.length > 1) this.map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 650 });
    else if (cities.length === 1) {
      const center = bounds.getCenter();
      this.map.flyTo({ center: [center.lng, center.lat], zoom: 5, duration: 650 });
    }
  }

  _renderWaypoints() {
    for (const [, mk] of this.wpMarkers) mk.remove();
    this.wpMarkers.clear();
    for (const wp of this.waypoints) {
      const [lon, lat] = toDisplay(wp.lon, wp.lat, this.coordSystem);
      const node = document.createElement('div');
      node.className = 'wp-marker' + (wp.hidden ? ' hidden-wp' : '');
      node.textContent = WP_ICONS[wp.type] || WP_ICONS.custom;
      node.title = wp.name || '';
      const mk = new maplibregl.Marker({ element: node, draggable: this.editMode, anchor: 'bottom' })
        .setLngLat([lon, lat]).addTo(this.map);
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        this.opts.onWaypointClick?.(wp);
      });
      mk.on('dragend', () => {
        const ll = mk.getLngLat();
        const [wLon, wLat] = fromDisplay(ll.lng, ll.lat, this.coordSystem);
        this.opts.onWaypointMove?.(wp, wLon, wLat);
      });
      this.wpMarkers.set(wp.id, mk);
    }
  }

  // ---------- live recording ----------
  startLive() {
    this.liveMode = true;
    this._liveZoomed = false;
    this.segments = [];
    this.waypoints = [];
    this.map.getSource('live')?.setData({ type: 'FeatureCollection', features: [] });
    this.map.getSource('track')?.setData({ type: 'FeatureCollection', features: [] });
    this.map.getSource('gaps')?.setData({ type: 'FeatureCollection', features: [] });
    this._liveFeats = new Map();
    for (const [, mk] of this.wpMarkers) mk.remove();
    this.wpMarkers.clear();
    this._clearVertices();
  }

  appendLive(point, segmentId) {
    if (!this._liveFeats) this._liveFeats = new Map();
    const coord = toDisplay(point.lon, point.lat, this.coordSystem);
    let feat = this._liveFeats.get(segmentId);
    if (!feat) {
      feat = { type: 'Feature', properties: { seg: segmentId }, geometry: { type: 'LineString', coordinates: [] } };
      this._liveFeats.set(segmentId, feat);
    }
    feat.geometry.coordinates.push(coord);
    this.map.getSource('live')?.setData({ type: 'FeatureCollection', features: [...this._liveFeats.values()] });
    this.updatePosition(point.lat, point.lon, point.acc, point.heading);
    if (this.follow) {
      const opts: any = { center: coord, duration: 400 };
      if (!this._liveZoomed) { opts.zoom = Math.max(this.map.getZoom(), 15); this._liveZoomed = true; }
      this.map.easeTo(opts);
    }
  }

  endLive() {
    this.liveMode = false;
    this._liveFeats = null;
    this.map.getSource('live')?.setData({ type: 'FeatureCollection', features: [] });
  }

  updatePosition(lat, lon, acc, heading) {
    const [dLon, dLat] = toDisplay(lon, lat, this.coordSystem);
    if (!this.posMarker) {
      const node = document.createElement('div');
      node.className = 'pos-marker';
      const arrow = document.createElement('div');
      arrow.className = 'pos-heading';
      node.append(arrow);
      this._headingEl = arrow;
      this.posMarker = new maplibregl.Marker({ element: node }).setLngLat([dLon, dLat]).addTo(this.map);
    } else {
      this.posMarker.setLngLat([dLon, dLat]);
    }
    if (this._headingEl) {
      this._headingEl.style.display = heading != null ? 'block' : 'none';
      if (heading != null) this._headingEl.style.transform = `translateX(-50%) rotate(${heading}deg)`;
    }
    // accuracy circle
    if (acc != null && acc > 0 && acc < 2000) {
      const rLat = acc / 111320;
      const rLon = acc / (111320 * Math.cos((dLat * Math.PI) / 180));
      const ring = [];
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2;
        ring.push([dLon + rLon * Math.cos(a), dLat + rLat * Math.sin(a)]);
      }
      this.map.getSource('pos')?.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }]
      });
    }
  }

  clearPosition() {
    if (this.posMarker) {
      const node = this.posMarker.getElement();
      node.classList.remove('meet-self');
      node.style.removeProperty('--self-color');
    }
    this.posMarker?.remove();
    this.posMarker = null;
    this._headingEl = null;
    this.map.getSource('pos')?.setData({ type: 'FeatureCollection', features: [] });
  }

  // ---------- live meetup ----------
  setMeetData({ self = null, peers = [], route = null }: { self?: any; peers?: any[]; route?: any } = {}) {
    this.meetSelf = self;
    this.meetPeers = Array.isArray(peers) ? peers : [];
    this.meetRoute = route;
    if (!this.map || this.destroyed) return;
    if (self?.hasFix && self.lat != null && self.lon != null) {
      this.updatePosition(self.lat, self.lon, self.acc, self.heading);
      const color = /^#[0-9a-f]{6}$/i.test(String(self.color))
        ? self.color : meetRoleColor(!!self.isHost);
      const node = this.posMarker?.getElement();
      node?.classList.add('meet-self');
      node?.style.setProperty('--self-color', color);
    } else {
      this.clearPosition();
    }
    this._renderMeetMarkers();
    this._applyMeetLinks();
    this._applyMeetRoute();
    this._updateMeetProximity();
  }

  clearMeetData() {
    this.meetSelf = null;
    this.meetPeers = [];
    this.meetRoute = null;
    this._meetAutoZoomReady = false;
    this._meetLastDistance = Number.NaN;
    this._meetLastSelf = null;
    this._meetCameraAnimating = false;
    for (const [, entry] of this.meetMarkers) entry.marker.remove();
    this.meetMarkers.clear();
    this.map?.getSource('meet-links')?.setData({ type: 'FeatureCollection', features: [] });
    this.map?.getSource('meet-route')?.setData({ type: 'FeatureCollection', features: [] });
  }

  _renderMeetMarkers() {
    if (!this.map || this.destroyed) return;
    const alive = new Set<string>();
    for (const p of this.meetPeers) {
      if (p.lat == null || p.lon == null) continue;
      alive.add(p.id);
      let entry = this.meetMarkers.get(p.id);
      if (!entry) {
        const node = document.createElement('div');
        node.className = 'meet-peer-marker';
        const dot = document.createElement('span');
        dot.className = 'mp-dot';
        const tag = document.createElement('span');
        tag.className = 'mp-tag';
        node.append(dot, tag);
        const marker = new maplibregl.Marker({ element: node, anchor: 'center' })
          .setLngLat(toDisplay(p.lon, p.lat, this.coordSystem) as [number, number]).addTo(this.map);
        entry = { node, dot, tag, marker, peer: p };
        const peerId = p.id;
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          this.opts.onMeetPeerClick?.(peerId);
        });
        this.meetMarkers.set(p.id, entry);
      }
      entry.peer = p;
      entry.node.classList.toggle('stale', !!p.stale);
      entry.node.style.setProperty('--peer', /^#[0-9a-f]{6}$/i.test(String(p.color)) ? p.color : '#2bcda7');
      entry.tag.textContent = p.name || '';
      const [lon, lat] = toDisplay(p.lon, p.lat, this.coordSystem);
      entry.marker.setLngLat([lon, lat] as [number, number]);
    }
    for (const [id, entry] of this.meetMarkers) {
      if (!alive.has(id)) { entry.marker.remove(); this.meetMarkers.delete(id); }
    }
  }

  _applyMeetLinks() {
    const source = this.map?.getSource('meet-links');
    if (!source) return;
    const s = this.meetSelf;
    const features = [];
    if (s?.hasFix && s.lat != null && s.lon != null) {
      const [slon, slat] = toDisplay(s.lon, s.lat, this.coordSystem);
      for (const p of this.meetPeers) {
        if (p.lat == null || p.lon == null) continue;
        const [plon, plat] = toDisplay(p.lon, p.lat, this.coordSystem);
        features.push({
          type: 'Feature',
          properties: { color: /^#[0-9a-f]{6}$/i.test(String(p.color)) ? p.color : '#2bcda7', stale: !!p.stale },
          geometry: { type: 'LineString', coordinates: [[slon, slat], [plon, plat]] }
        });
      }
    }
    source.setData({ type: 'FeatureCollection', features });
  }

  _applyMeetRoute() {
    const source = this.map?.getSource('meet-route');
    if (!source) return;
    const coords = this.meetRoute?.coords;
    const features = [];
    if (Array.isArray(coords) && coords.length >= 2) {
      features.push({
        type: 'Feature', properties: {},
        geometry: { type: 'LineString', coordinates: coords.map(([lon, lat]) => toDisplay(lon, lat, this.coordSystem)) }
      });
    }
    source.setData({ type: 'FeatureCollection', features });
  }

  _applyMeetData() {
    if (!this.map || this.destroyed) return;
    if (this.meetSelf?.hasFix && this.meetSelf.lat != null) {
      this.updatePosition(this.meetSelf.lat, this.meetSelf.lon, this.meetSelf.acc, this.meetSelf.heading);
    }
    this._renderMeetMarkers();
    this._applyMeetLinks();
    this._applyMeetRoute();
  }

  _updateMeetProximity() {
    if (!this.map || this.destroyed || !this._meetAutoZoomReady) return;
    const self = this.meetSelf;
    if (!self?.hasFix || self.lat == null || self.lon == null) return;
    if (this.map.isMoving() || Date.now() < this._meetManualCameraUntil) return;
    const candidates = this.meetPeers.filter((p) => !p.stale && p.lat != null && p.lon != null);
    const allCandidates = this.meetPeers.filter((p) => p.lat != null && p.lon != null);
    const pool = candidates.length ? candidates : allCandidates;
    if (!pool.length) return;
    const nearest = (a, b) => haversine(self.lat, self.lon, a.lat, a.lon) - haversine(self.lat, self.lon, b.lat, b.lon);
    const target = self.isHost ? [...pool].sort(nearest)[0] : pool.find((p) => p.isHost) || [...pool].sort(nearest)[0];
    const distance = haversine(self.lat, self.lon, target.lat, target.lon);
    const targetZoom = meetProximityZoom(distance, self.lat);
    const moved = !this._meetLastSelf || haversine(self.lat, self.lon, this._meetLastSelf.lat, this._meetLastSelf.lon) > 12;
    const changed = !Number.isFinite(this._meetLastDistance)
      || Math.abs(distance - this._meetLastDistance) / Math.max(1, this._meetLastDistance) > 0.25;
    if (!moved && !changed && Math.abs(this.map.getZoom() - targetZoom) <= 0.4) return;
    const selfCoord = toDisplay(self.lon, self.lat, this.coordSystem);
    const targetCoord = toDisplay(target.lon, target.lat, this.coordSystem);
    this._meetLastDistance = distance;
    this._meetLastSelf = { lat: self.lat, lon: self.lon };
    this._meetCameraAnimating = true;
    this.map.once('moveend', () => { this._meetCameraAnimating = false; });
    this.map.easeTo({
      center: [(selfCoord[0] + targetCoord[0]) / 2, (selfCoord[1] + targetCoord[1]) / 2] as [number, number],
      zoom: targetZoom,
      duration: 850
    });
  }

  fitMeet(padding = 70) {
    if (!this.map || this.destroyed) return;
    this._meetAutoZoomReady = false;
    this._meetLastDistance = Number.NaN;
    this._meetLastSelf = null;
    const pts = [];
    if (this.meetSelf?.hasFix && this.meetSelf.lat != null) pts.push(toDisplay(this.meetSelf.lon, this.meetSelf.lat, this.coordSystem));
    for (const p of this.meetPeers) {
      if (p.lat != null && p.lon != null) pts.push(toDisplay(p.lon, p.lat, this.coordSystem));
    }
    if (!pts.length) return;
    this.follow = false;
    emit('map:followoff');
    if (pts.length === 1) {
      this._meetAutoZoomReady = true;
      this._meetCameraAnimating = true;
      this.map.once('moveend', () => { this._meetCameraAnimating = false; });
      this.map.easeTo({ center: pts[0], zoom: Math.max(this.map.getZoom(), 14), duration: 600 });
      return;
    }
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const [lon, lat] of pts) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    this._meetAutoZoomReady = true;
    this._meetCameraAnimating = true;
    this.map.once('moveend', () => { this._meetCameraAnimating = false; });
    this.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: { top: padding, right: padding, bottom: padding + this._viewportBottom, left: padding },
      duration: 650, maxZoom: 16
    });
  }

  // ---------- re-walk approach guide ----------
  setNavGuide(lat, lon, targetLat, targetLon, label) {
    if (!this.map || this.destroyed) return;
    const [dLon, dLat] = toDisplay(lon, lat, this.coordSystem);
    const [tLon, tLat] = toDisplay(targetLon, targetLat, this.coordSystem);
    this.map.getSource('nav')?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[dLon, dLat], [tLon, tLat]] } }]
    });
    if (!this.navMarker) {
      const node = document.createElement('div');
      node.className = 'rw-target-marker';
      node.innerHTML = '<span class="rw-target-label"></span><span class="rw-target-dot"></span>';
      this.navMarker = new maplibregl.Marker({ element: node, anchor: 'center' }).setLngLat([tLon, tLat]).addTo(this.map);
    } else {
      this.navMarker.setLngLat([tLon, tLat]);
    }
    const lb = this.navMarker.getElement().querySelector('.rw-target-label');
    if (lb) lb.textContent = label || '';
  }

  clearNavGuide() {
    this.navMarker?.remove();
    this.navMarker = null;
    this.map?.getSource('nav')?.setData({ type: 'FeatureCollection', features: [] });
  }

  setPhotoRef(lat, lon, label = '') {
    if (!this.map || this.destroyed) return;
    this.clearPhotoRef();
    const [dLon, dLat] = toDisplay(lon, lat, this.coordSystem);
    const node = document.createElement('div');
    node.className = 'photo-ref-marker';
    node.innerHTML = '<span class="photo-ref-dot"></span><span class="photo-ref-label"></span>';
    const lb = node.querySelector('.photo-ref-label');
    if (lb) lb.textContent = label;
    this.photoRefMarker = new maplibregl.Marker({ element: node, anchor: 'center' }).setLngLat([dLon, dLat]).addTo(this.map);
  }

  clearPhotoRef() {
    this.photoRefMarker?.remove();
    this.photoRefMarker = null;
  }

  // ---------- editing ----------
  setEditMode(on) {
    this.editMode = on;
    this._renderWaypoints();
    if (on) this._scheduleVertices();
    else this._clearVertices();
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  _scheduleVertices() {
    if (this._moveTimer) clearTimeout(this._moveTimer);
    this._moveTimer = setTimeout(() => this._renderVertices(), 180);
  }

  _clearVertices() {
    for (const v of this.vertexMarkers) v.mk.remove();
    this.vertexMarkers = [];
  }

  _renderVertices() {
    this._clearVertices();
    if (!this.editMode || this.liveMode || this.map.getZoom() < 13) return;
    const bounds = this.map.getBounds();
    const zoom = this.map.getZoom();
    const tol = Math.max(2, 360 / Math.pow(2, zoom) * 111320 / 256 * 3);
    let count = 0;
    for (const seg of this.segments) {
      if (count > 260) break;
      const visible = seg.points.filter((p) =>
        p.lon >= bounds.getWest() - 0.01 && p.lon <= bounds.getEast() + 0.01 &&
        p.lat >= bounds.getSouth() - 0.01 && p.lat <= bounds.getNorth() + 0.01);
      if (!visible.length) continue;
      const shown = visible.length > 120 ? simplify(visible, tol) : visible;
      const idxMap = this._indexMaps.get(seg.id);
      shown.forEach((p, si) => {
        if (count > 260) return;
        const [lon, lat] = toDisplay(p.lon, p.lat, this.coordSystem);
        const node = document.createElement('div');
        node.className = 'edit-vertex';
        const mk = new maplibregl.Marker({ element: node, draggable: true }).setLngLat([lon, lat]).addTo(this.map);
        const origIdx = idxMap?.get(p) ?? seg.points.indexOf(p);
        mk.on('dragend', () => {
          const ll = mk.getLngLat();
          const [wLon, wLat] = fromDisplay(ll.lng, ll.lat, this.coordSystem);
          this.opts.onVertexMove?.(seg.id, origIdx, wLon, wLat);
        });
        node.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.opts.onVertexDelete?.(seg.id, origIdx);
        });
        this.vertexMarkers.push({ mk, p, seg, origIdx });
        count++;
        // midpoint insert handle
        const next = shown[si + 1];
        if (next && count <= 260) {
          const [nLon, nLat] = toDisplay(next.lon, next.lat, this.coordSystem);
          const mNode = document.createElement('div');
          mNode.className = 'edit-vertex mid';
          const mMid = new maplibregl.Marker({ element: mNode }).setLngLat([(lon + nLon) / 2, (lat + nLat) / 2]).addTo(this.map);
          mNode.addEventListener('click', (e) => {
            e.stopPropagation();
            const ll = mMid.getLngLat();
            const [wLon, wLat] = fromDisplay(ll.lng, ll.lat, this.coordSystem);
            this.opts.onVertexInsert?.(seg.id, origIdx, wLon, wLat);
          });
          this.vertexMarkers.push({ mk: mMid });
          count++;
        }
      });
    }
  }

  // ---------- navigation ----------
  fitTrack(padding = 60) {
    const pts = this.segments.flatMap((s) => s.points);
    if (!pts.length) return;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const p of pts) {
      const [lon, lat] = toDisplay(p.lon, p.lat, this.coordSystem);
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    this.follow = false;
    this.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: { top: padding, right: padding, bottom: padding + this._viewportBottom, left: padding },
      duration: 600, maxZoom: 17
    });
  }

  setFollow(on) {
    this.follow = on;
    if (on && this.posMarker) {
      const opts: any = { center: this.posMarker.getLngLat(), duration: 400 };
      if (this.liveMode) opts.zoom = Math.max(this.map.getZoom(), 15);
      this.map.easeTo(opts);
    }
  }

  flyTo(lat, lon, zoom = 15) {
    const [dLon, dLat] = toDisplay(lon, lat, this.coordSystem);
    this.map.flyTo({ center: [dLon, dLat], zoom, duration: 700 });
  }

  showHover(lat, lon, label) {
    const [dLon, dLat] = toDisplay(lon, lat, this.coordSystem);
    if (!this.hoverMarker) {
      const node = document.createElement('div');
      node.className = 'chart-hover-dot';
      node.style.display = 'block';
      node.style.position = 'relative';
      node.style.transform = 'none';
      this.hoverMarker = new maplibregl.Marker({ element: node }).setLngLat([dLon, dLat]).addTo(this.map);
    } else {
      this.hoverMarker.setLngLat([dLon, dLat]);
    }
    const node = this.hoverMarker.getElement();
    let lb = node.querySelector('.chart-hover-label');
    if (label) {
      if (!lb) { lb = document.createElement('span'); lb.className = 'chart-hover-label'; node.append(lb); }
      lb.textContent = label;
    } else lb?.remove();
  }
  clearHover() { this.hoverMarker?.remove(); this.hoverMarker = null; }

  getCanvas() { return this.map.getCanvas(); }
  resize() {
    this.map?.resize();
    this.updateViewportInset();
  }

  pauseRendering() {
    const m = this.map;
    if (!m || this.destroyed || m._removed || this._renderingPaused) return;
    this._renderingPaused = true;
    this._pausedRepaintDescriptor = Object.getOwnPropertyDescriptor(m, 'triggerRepaint');
    // MapLibre 6 renders on demand, so stop() alone does not stop repaint requests.
    m.triggerRepaint = () => {};
    m.stop();
    m._frameRequest?.abort?.();
    m._frameRequest = null;
  }

  resumeRendering() {
    const m = this.map;
    if (!m || this.destroyed || m._removed || !this._renderingPaused) return;
    if (this._pausedRepaintDescriptor) Object.defineProperty(m, 'triggerRepaint', this._pausedRepaintDescriptor);
    else delete m.triggerRepaint;
    this._pausedRepaintDescriptor = undefined;
    this._renderingPaused = false;
    m.resize();
    m.redraw();
  }

  destroy() {
    this.destroyed = true;
    this._viewportObserver?.disconnect();
    this._viewportObserver = null;
    this._viewportOverlay = null;
    cancelAnimationFrame(this._viewportFrame);
    this._offRegion?.();
    this._offProbe?.();
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    this._offTheme?.();
    this._clearVertices();
    for (const [, mk] of this.wpMarkers) mk.remove();
    for (const marker of this.cityMarkers) marker.remove();
    this.cityMarkers = [];
    for (const [, entry] of this.meetMarkers) entry.marker.remove();
    this.meetMarkers.clear();
    this.posMarker?.remove();
    this.hoverMarker?.remove();
    this.navMarker?.remove();
    this.photoRefMarker?.remove();
    this.map?.remove();
  }
}

export { haversine, regionState, LIVE_FILL };