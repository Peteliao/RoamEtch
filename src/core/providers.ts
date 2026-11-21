// ProviderRegistry [v1.4]: all external capabilities are dispatched through adapters here.
// Network region picks the *service stack*; each basemap carries its own coordSystem
// which alone (plus the China fence) decides GCJ-02 offsetting at render time.
import { get } from './settings';
import { regionState, isOfflineSim } from './region';
import { effectiveTheme } from './theme';

const TIANDITU = (layer, key) =>
  `https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&tk=${key}`;

export const BASEMAPS = [
  // ---- CN profile ----
  {
    id: 'amap-vec', profile: 'cn', kind: 'street', name: '高德街道', nameEn: 'AMap Street',
    coordSystem: 'GCJ02', maxzoom: 18,
    tiles: ['https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'],
    subdomains: ['1', '2', '3', '4'], attribution: '© 高德软件'
  },
  {
    id: 'amap-sat', profile: 'cn', kind: 'satellite', name: '高德卫星', nameEn: 'AMap Satellite',
    coordSystem: 'GCJ02', maxzoom: 18,
    tiles: ['https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}'],
    subdomains: ['1', '2', '3', '4'], attribution: '© 高德软件'
  },
  {
    id: 'tianditu-vec', profile: 'cn', kind: 'street', name: '天地图街道', nameEn: 'Tianditu Street',
    coordSystem: 'WGS84', maxzoom: 18, requiresKey: 'tiandituKey',
    tiles: (k) => [TIANDITU('vec', k)], overlay: (k) => TIANDITU('cva', k),
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], attribution: '© 天地图 CGCS2000'
  },
  {
    id: 'tianditu-ter', profile: 'cn', kind: 'terrain', name: '天地图地形', nameEn: 'Tianditu Terrain',
    coordSystem: 'WGS84', maxzoom: 14, requiresKey: 'tiandituKey',
    tiles: (k) => [TIANDITU('ter', k)], overlay: (k) => TIANDITU('cta', k),
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], attribution: '© 天地图 CGCS2000'
  },
  {
    id: 'tianditu-img', profile: 'cn', kind: 'satellite', name: '天地图影像', nameEn: 'Tianditu Imagery',
    coordSystem: 'WGS84', maxzoom: 18, requiresKey: 'tiandituKey',
    tiles: (k) => [TIANDITU('img', k)], overlay: (k) => TIANDITU('cia', k),
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'], attribution: '© 天地图 CGCS2000'
  },
  // ---- Global profile ----
  {
    id: 'osm', profile: 'global', kind: 'street', name: 'OpenStreetMap', nameEn: 'OpenStreetMap',
    coordSystem: 'WGS84', maxzoom: 19,
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors'
  },
  {
    id: 'opentopo', profile: 'global', kind: 'terrain', name: 'OpenTopoMap', nameEn: 'OpenTopoMap',
    coordSystem: 'WGS84', maxzoom: 17,
    tiles: ['https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'],
    subdomains: ['a', 'b', 'c'], attribution: '© OpenTopoMap (CC-BY-SA) · © OpenStreetMap'
  },
  {
    id: 'esri-sat', profile: 'global', kind: 'satellite', name: 'Esri 影像', nameEn: 'Esri Imagery',
    coordSystem: 'WGS84', maxzoom: 19,
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: '© Esri · Maxar · Earthstar Geographics'
  },
  // OSM also offered inside CN as a WGS-84 fallback (may be slow without proxy)
  {
    id: 'osm-cn', profile: 'cn', kind: 'street', name: 'OSM（国际）', nameEn: 'OSM (intl.)',
    coordSystem: 'WGS84', maxzoom: 19,
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© OpenStreetMap contributors'
  }
];

export function customBasemap() {
  const url = get('customTileUrl');
  if (!url || !/\{z\}/.test(url)) return null;
  return {
    id: 'custom', profile: 'both', kind: 'street',
    name: get('customTileName') || '自定义图源', nameEn: get('customTileName') || 'Custom',
    coordSystem: 'WGS84', maxzoom: 20, tiles: [url], attribution: 'Custom tiles'
  };
}

export function availableBasemaps() {
  const eff = regionState.effective;
  const list = BASEMAPS.filter((b) => {
    if (b.profile !== eff && b.profile !== 'both') return false;
    if (b.requiresKey && !get(b.requiresKey)) return false;
    return true;
  });
  const custom = customBasemap();
  if (custom) list.push(custom);
  return list;
}

export function getBasemap(id) {
  if (id === 'custom') return customBasemap();
  return BASEMAPS.find((b) => b.id === id) || null;
}

export function defaultBasemapId() {
  const list = availableBasemaps();
  const pref = regionState.effective === 'cn' ? 'amap-vec' : 'osm';
  return (list.find((b) => b.id === pref) || list[0])?.id || null;
}

function expandSubdomains(urls, subs) {
  if (!subs) return urls;
  return urls.flatMap((u) => (u.includes('{s}') ? subs.map((s) => u.replace('{s}', s)) : [u]));
}

export function expandTiles(provider, key) {
  const raw = typeof provider.tiles === 'function' ? provider.tiles(key) : provider.tiles;
  return expandSubdomains(raw, provider.subdomains);
}

export function vectorBgColor() {
  const eff = effectiveTheme();
  return eff === 'light' ? '#f5f7f6' : eff === 'contrast' ? '#ffffff' : '#000000';
}

/** Build a fully self-contained raster style (no external style/glyph/sprite fetches). */
export function buildRasterStyle(provider) {
  const key = provider.requiresKey ? get(provider.requiresKey) : '';
  const sources: any = {};
  const layers: any[] = [{ id: 'bg', type: 'background', paint: { 'background-color': vectorBgColor() } }];
  const tiles = expandTiles(provider, key);
  sources['base'] = {
    type: 'raster', tiles, tileSize: 256,
    maxzoom: provider.maxzoom, attribution: provider.attribution
  };
  layers.push({ id: 'base-raster', type: 'raster', source: 'base', paint: { 'raster-fade-duration': 120 } });
  if (provider.overlay) {
    sources['overlay'] = {
      type: 'raster', tiles: expandSubdomains([provider.overlay(key)], provider.subdomains), tileSize: 256,
      maxzoom: provider.maxzoom
    };
    layers.push({ id: 'overlay-raster', type: 'raster', source: 'overlay', paint: { 'raster-fade-duration': 120 } });
  }
  return { version: 8, name: provider.id, sources, layers };
}

/** Empty style for offline / vector-fallback mode: grid background, track still renders. */
export function buildVectorStyle() {
  return {
    version: 8, name: 'vector-fallback', sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': vectorBgColor() } }]
  };
}

// ---- Elevation adapter (grid-cached, batched) ----
export function elevationEndpoint() {
  const custom = get('elevationEndpoint');
  if (custom) return custom;
  // Open-Meteo is reachable from both regions; CN users may override with a domestic mirror.
  return 'https://api.open-meteo.com/v1/elevation';
}

export function isServiceOffline() { return isOfflineSim(); }