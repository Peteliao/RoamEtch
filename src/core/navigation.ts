import { isInMainlandChina, wgs84ToGcj02 } from './coords';

export type NavigationPlatform = 'ios' | 'android' | 'web';
export type NavigationMode = 'driving' | 'walking';

export interface NavigationLinks {
  provider: 'amap' | 'google';
  mode: NavigationMode;
  primary: string;
  fallback: string;
}

export function navigationMode(distanceM: number): NavigationMode {
  return distanceM >= 2000 ? 'driving' : 'walking';
}

export function navigationLinks(
  lat: number,
  lon: number,
  distanceM: number,
  name = '',
  platform: NavigationPlatform = 'web'
): NavigationLinks | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)
    || lat < -90 || lat > 90 || lon < -180 || lon > 180
    || !Number.isFinite(distanceM) || distanceM < 0) return null;

  const mode = navigationMode(distanceM);
  const destinationName = name.trim() || 'RoamEtch';
  if (isInMainlandChina(lat, lon)) {
    const [displayLon, displayLat] = wgs84ToGcj02(lon, lat);
    const nativeParams = new URLSearchParams({
      sourceApplication: 'RoamEtch',
      dlat: displayLat.toFixed(6),
      dlon: displayLon.toFixed(6),
      dname: destinationName,
      dev: '0',
      t: mode === 'driving' ? '0' : '2'
    });
    const scheme = platform === 'ios' ? 'iosamap://path' : 'androidamap://route';
    return {
      provider: 'amap',
      mode,
      primary: platform === 'web' ? amapWebUrl(displayLat, displayLon, destinationName, mode) : `${scheme}?${nativeParams}`,
      fallback: amapWebUrl(displayLat, displayLon, destinationName, mode)
    };
  }

  const params = new URLSearchParams({
    api: '1',
    destination: `${lat.toFixed(6)},${lon.toFixed(6)}`,
    travelmode: mode,
    dir_action: 'navigate'
  });
  const url = `https://www.google.com/maps/dir/?${params}`;
  return { provider: 'google', mode, primary: url, fallback: url };
}

function amapWebUrl(lat: number, lon: number, name: string, mode: NavigationMode) {
  const params = new URLSearchParams({
    to: `${lon.toFixed(6)},${lat.toFixed(6)}`,
    dname: name,
    mode: mode === 'driving' ? 'car' : 'walk',
    policy: '1',
    src: 'RoamEtch',
    coordinate: 'gaode',
    callnative: '0'
  });
  return `https://uri.amap.com/navigation?${params}`;
}
