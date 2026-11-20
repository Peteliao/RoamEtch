// MapLibre wrapper: profile-driven basemaps, WGS-84 storage with render-time
// GCJ-02 adaptation, incremental live track, waypoint/vertex editing, vector fallback.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { toDisplay, fromDisplay } from '../core/coords';
import { getBasemap, buildRasterStyle, buildVectorStyle, availableBasemaps, defaultBasemapId, vectorBgColor } from '../core/providers';
import { isOfflineSim, regionState } from '../core/region';
import { simplify, haversine } from '../core/geo';
import { on, emit } from '../core/events';
import { diag } from '../core/diag';

export const WP_ICONS = {
  start: '🚩', end: '🏁', view: '👁️', photo: '📷', stay: '🏨',
  food: '🍜', supply: '🛒', danger: '⚠️', fuel: '⛽', custom: '📍'
};

const LIVE_FILL = 'rgba(90,167,240,0.14)';

export class TrackMap {
  declare container: HTMLElement;
  declare opts: any;
  declare coordSystem: string;
  declare basemapId: string | null;
  declare segments: any[];
  declare waypoints: any[];
  declare editMode: boolean;
  declare follow: boolean;
  declare liveMode: boolean;
  declare wpMarkers: Map<any, any>;
  declare vertexMarkers: any[];
  declare posMarker: any;
  declare hoverMarker: any;
  declare tileErrors: number;
  declare tileLoaded: boolean;
  declare vectorFallback: boolean;
  declare _indexMaps: Map<string, any>;
  declare _moveTimer: any;
  declare destroyed: boolean;
  declare map: any;
  declare _offRegion: any;
  declare _offTheme: any;
  declare _fallbackEl: HTMLElement | null;
  declare _liveZoomed: boolean;
  declare _liveFeats: Map<string, any> | null;
  declare _headingEl: HTMLElement | null;

  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.coordSystem = 'WGS84';
    this.basemapId = null;
    this.segments = [];          // [{id, points}] WGS-84
    this.waypoints = [];
    this.editMode = false;
    this.follow = false;
    this.liveMode = false;
    this.wpMarkers = new Map();
    this.vertexMarkers = [];
    this.posMarker = null;
    this.hoverMarker = null;
    this.tileErrors = 0;
    this.tileLoaded = false;
    this.vectorFallback = false;
    this._indexMaps = new Map();
    this._moveTimer = null;
    this.destroyed = false;
  }

  init(center = [116.4, 39.9], zoom = 10) {
    const offline = isOfflineSim();
    const provider = offline ? null : getBasemap(defaultBasemapId());
    this.basemapId = provider?.id || null;
    this.coordSystem = provider?.coordSystem || 'WGS84';
    this.vectorFallback = !provider;
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
      if (this.editMode) this._scheduleVertices();
    });
    this.map.on('click', (e) => {
      if (!this.editMode) return;
      const [lon, lat] = fromDisplay(e.lngLat.lng, e.lngLat.lat, this.coordSystem);
      this.opts.onMapClick?.(lon, lat);
    });
    this.map.on('dragstart', () => { this.follow = false; emit('map:followoff'); });
    this._offRegion = on('region:changed', () => { if (!this.liveMode) this.refreshBasemapForRegion(); });
    this._offTheme = on('theme:applied', () => this._applyTheme());
    return this;
  }

  // Basemap tiles stay full-color in every theme; only the loading background follows it.
  _applyTheme() {
    const m = this.map;
    if (!m || this.destroyed) return;
    const apply = () => {
      if (m.getLayer('bg')) m.setPaintProperty('bg', 'background-color', vectorBgColor());
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
    if (this.vectorFallback) { this.setBasemap(keep?.id || defaultBasemapId()); return; }
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
    if (this.basemapId) this.setBasemap(this.basemapId);
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
    box.textContent = '⚠ ' + (this.opts.fallbackText || '底图不可达 · 纯矢量模式');
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
    if (!m.getSource('live')) {
      m.addSource('live', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getSource('pos')) {
      m.addSource('pos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    }
    if (!m.getLayer('pos-acc')) m.addLayer({ id: 'pos-acc', type: 'fill', source: 'pos', paint: { 'fill-color': '#5aa7f0', 'fill-opacity': 0.12 } });
    if (!m.getLayer('gap-line')) m.addLayer({ id: 'gap-line', type: 'line', source: 'gaps', paint: { 'line-color': '#8a97ad', 'line-width': 1.6, 'line-dasharray': [2, 2.4], 'line-opacity': 0.65 } });
    if (!m.getLayer('track-casing')) m.addLayer({ id: 'track-casing', type: 'line', source: 'track', paint: { 'line-color': '#06231c', 'line-width': 7, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('track-line')) m.addLayer({ id: 'track-line', type: 'line', source: 'track', paint: { 'line-color': '#2dd4a7', 'line-width': 4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('live-casing')) m.addLayer({ id: 'live-casing', type: 'line', source: 'live', paint: { 'line-color': '#06231c', 'line-width': 7, 'line-opacity': 0.55 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
    if (!m.getLayer('live-line')) m.addLayer({ id: 'live-line', type: 'line', source: 'live', paint: { 'line-color': '#2dd4a7', 'line-width': 4 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  }

  /** segments: [{id, points:[{lat,lon,...}]}] in WGS-84 */
  setTrackData(segments, waypoints = []) {
    this.segments = segments;
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
    this.posMarker?.remove();
    this.posMarker = null;
    this.map.getSource('pos')?.setData({ type: 'FeatureCollection', features: [] });
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
    this.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding, duration: 600, maxZoom: 17 });
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
  resize() { this.map?.resize(); }
  destroy() {
    this.destroyed = true;
    this._offRegion?.();
    this._offTheme?.();
    this._clearVertices();
    for (const [, mk] of this.wpMarkers) mk.remove();
    this.posMarker?.remove();
    this.hoverMarker?.remove();
    this.map?.remove();
  }
}

export { haversine, regionState, LIVE_FILL };