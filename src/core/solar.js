// Local sunrise/sunset (NOAA solar equations). No network: theme auto mode
// must work offline and never leak location.
const RAD = Math.PI / 180;

/**
 * @returns {{sunrise?:Date, sunset?:Date, polar:'day'|'night'|null}}
 */
export function sunTimes(date, lat, lon) {
  const y = date.getUTCFullYear(), m = date.getUTCMonth(), d = date.getUTCDate();
  const dayOfYear = Math.floor((Date.UTC(y, m, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + 0.5);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const latR = lat * RAD;
  const cosHa = Math.cos(90.833 * RAD) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
  if (cosHa > 1) return { polar: 'night' };
  if (cosHa < -1) return { polar: 'day' };
  const ha = Math.acos(cosHa) / RAD;
  const base = Date.UTC(y, m, d);
  return {
    sunrise: new Date(base + (720 - 4 * (lon + ha) - eqtime) * 60000),
    sunset: new Date(base + (720 - 4 * (lon - ha) - eqtime) * 60000),
    polar: null
  };
}

export function isDaylight(now, lat, lon) {
  const t = sunTimes(now, lat, lon);
  if (t.polar === 'day') return true;
  if (t.polar === 'night') return false;
  return now >= t.sunrise && now < t.sunset;
}