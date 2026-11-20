// WGS-84 <-> GCJ-02 conversion. Storage/analysis/import-export always stay WGS-84;
// this module is only used by the render/pick adapter when the active basemap is GCJ-02.

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

// Coarse mainland-China polygon fence (lat, lon pairs), clockwise.
// Approximation good to a few km near borders; combined with bbox pre-check.
const CHINA_FENCE = [
  [53.55, 120.0], [53.0, 126.0], [50.2, 127.6], [48.4, 130.6], [48.2, 134.7],
  [45.2, 133.6], [42.6, 131.1], [42.0, 130.6], [40.0, 124.4], [39.2, 122.2],
  [37.6, 122.7], [36.0, 120.6], [34.8, 120.3], [32.0, 121.9], [30.7, 122.4],
  [28.2, 121.7], [26.0, 120.1], [24.5, 118.6], [23.2, 117.2], [22.6, 115.5],
  [22.4, 114.3], [22.0, 113.6], [21.7, 112.2], [21.4, 110.4], [20.6, 110.3],
  [20.2, 109.7], [21.4, 108.6], [21.6, 107.9], [22.8, 106.6], [23.4, 105.3],
  [22.8, 103.9], [22.4, 102.1], [21.6, 101.7], [21.2, 100.1], [22.0, 99.2],
  [23.2, 98.8], [24.2, 97.6], [25.8, 98.6], [27.2, 97.8], [28.2, 96.4],
  [27.8, 94.0], [27.4, 92.0], [28.0, 90.0], [27.2, 88.9], [27.9, 87.0],
  [28.4, 85.0], [29.6, 82.0], [30.4, 80.0], [32.4, 79.0], [34.0, 78.6],
  [35.5, 77.0], [36.8, 75.2], [38.0, 74.0], [39.4, 73.6], [40.6, 76.0],
  [41.2, 80.2], [43.0, 80.6], [45.2, 82.2], [47.2, 85.6], [49.1, 87.8],
  [48.6, 90.6], [46.6, 96.0], [45.2, 100.2], [43.0, 105.0], [42.0, 110.2],
  [43.4, 112.0], [45.1, 112.4], [46.7, 117.4], [49.8, 116.7], [50.2, 119.5],
  [52.4, 120.6]
];
const HAINAN_FENCE = [
  [20.15, 109.4], [20.15, 110.7], [19.4, 111.05], [18.2, 109.7], [18.15, 108.6], [19.3, 108.55]
];
const BBOX = { minLat: 17.8, maxLat: 54.0, minLon: 73.0, maxLon: 135.2 };

function inPolygon(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function isInMainlandChina(lat, lon) {
  if (lat < BBOX.minLat || lat > BBOX.maxLat || lon < BBOX.minLon || lon > BBOX.maxLon) return false;
  return inPolygon(lat, lon, CHINA_FENCE) || inPolygon(lat, lon, HAINAN_FENCE);
}

function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * PI) + 320.0 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return r;
}
function transformLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return r;
}

function delta(lat, lon) {
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return [dLat, dLon];
}

/** WGS-84 -> GCJ-02. Returns [lon, lat]. Outside fence: unchanged. */
export function wgs84ToGcj02(lon, lat) {
  if (!isInMainlandChina(lat, lon)) return [lon, lat];
  const [dLat, dLon] = delta(lat, lon);
  return [lon + dLon, lat + dLat];
}

/** GCJ-02 -> WGS-84, iterative (sub-millimetre convergence). Returns [lon, lat]. */
export function gcj02ToWgs84(lon, lat) {
  if (!isInMainlandChina(lat, lon)) return [lon, lat];
  let wLon = lon, wLat = lat;
  for (let i = 0; i < 6; i++) {
    const [gLon, gLat] = wgs84ToGcj02(wLon, wLat);
    const dLon = lon - gLon, dLat = lat - gLat;
    wLon += dLon; wLat += dLat;
    if (Math.abs(dLon) < 1e-9 && Math.abs(dLat) < 1e-9) break;
  }
  return [wLon, wLat];
}

/**
 * Render adapter: convert a WGS-84 [lon,lat] for display on the active basemap.
 * @param {number} lon
 * @param {number} lat
 * @param {'WGS84'|'GCJ02'} coordSystem active basemap coordinate system
 */
export function toDisplay(lon, lat, coordSystem) {
  return coordSystem === 'GCJ02' ? wgs84ToGcj02(lon, lat) : [lon, lat];
}

/** Pick adapter: convert a clicked/dragged map position back to storage WGS-84. */
export function fromDisplay(lon, lat, coordSystem) {
  return coordSystem === 'GCJ02' ? gcj02ToWgs84(lon, lat) : [lon, lat];
}