// Historical weather adapter (Open-Meteo). Network is required unless a cached
// sample exists; every result carries its source and sample time so the UI can
// disclose both instead of implying offline weather.
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FIELDS = 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m,uv_index';
const FORECAST_DAYS = 92;
const CACHE_PREFIX = 'lt.weather.v1.';
const FETCH_TIMEOUT = 8000;

export const WEATHER_SOURCE = 'Open-Meteo';

export type WeatherHour = {
  h: number;
  temp: number | null;
  code: number | null;
  rain: number | null;
  wind: number | null;
  uv: number | null;
};

export type WeatherDay = {
  day: string;
  fetchedAt: number;
  source: string;
  model: 'forecast' | 'archive';
  timezone: string;
  hours: WeatherHour[];
};

export type WeatherSummary = {
  temp: number | null;
  code: number | null;
  condition?: string | null;
  rain: number | null;
  wind: number | null;
  gust?: number | null;
  precipitation?: number | null;
  uv: number | null;
  hour: number;
  sample: string;
  missing: Array<'rain' | 'uv'>;
};

export type ManualWeather = {
  temp?: number | null;
  condition?: string;
  rain?: number | null;
  wind?: number | null;
  uv?: number | null;
  note?: string;
  updatedAt?: number;
};

export function weatherDayKey(ts: number) {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayDiff(a: string, b: string) {
  const pa = new Date(`${a}T12:00:00`).getTime();
  const pb = new Date(`${b}T12:00:00`).getTime();
  return Math.round((pa - pb) / 86400000);
}

export function weatherModelFor(day: string, today = weatherDayKey(Date.now())) {
  const age = dayDiff(today, day);
  return age <= FORECAST_DAYS && age >= -16 ? 'forecast' : 'archive';
}

export function weatherUrl(lat: number, lon: number, day: string, model = weatherModelFor(day)) {
  const base = model === 'archive' ? ARCHIVE : FORECAST;
  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    start_date: day,
    end_date: day,
    hourly: FIELDS,
    timezone: 'auto'
  });
  return `${base}?${q.toString()}`;
}

function hourOf(iso: string) {
  const m = /T(\d{2}):/.exec(iso);
  return m ? Number(m[1]) : null;
}

export function parseWeatherPayload(payload: any, day: string): WeatherDay {
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time) || !hourly.time.length) throw new Error('bad weather payload');
  const pick = (name: string, i: number) => {
    const value = hourly[name]?.[i];
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  let indices = hourly.time.map((t: string, i: number) => ({ t, i })).filter((x) => String(x.t).startsWith(day));
  if (!indices.length) indices = hourly.time.map((t: string, i: number) => ({ t, i })).slice(0, 24);
  const hours = indices.map(({ t, i }) => ({
    h: hourOf(String(t)) ?? 0,
    temp: pick('temperature_2m', i),
    code: pick('weather_code', i),
    rain: pick('precipitation_probability', i),
    wind: pick('wind_speed_10m', i),
    uv: pick('uv_index', i)
  })).sort((a, b) => a.h - b.h);
  const model = /archive-api/.test(String(payload?.source || '')) ? 'archive' : (payload?.model || 'forecast');
  return {
    day,
    fetchedAt: Date.now(),
    source: payload?.source || WEATHER_SOURCE,
    model,
    timezone: payload?.timezone || '',
    hours
  };
}

export function pickWeatherHour(day: WeatherDay, timeMs?: number | null) {
  if (!day.hours.length) return null;
  if (timeMs == null || !Number.isFinite(timeMs)) return day.hours.find((h) => h.h === 12) || day.hours[0];
  const target = new Date(timeMs).getHours();
  let best = day.hours[0];
  let bestDelta = Infinity;
  for (const hour of day.hours) {
    const delta = Math.abs(hour.h - target);
    if (delta < bestDelta) { best = hour; bestDelta = delta; }
  }
  return best;
}

export function summarizeWeather(day: WeatherDay, timeMs?: number | null): WeatherSummary {
  const hour = pickWeatherHour(day, timeMs) || { h: 12, temp: null, code: null, rain: null, wind: null, uv: null };
  const missing: WeatherSummary['missing'] = [];
  if (hour.rain == null) missing.push('rain');
  if (hour.uv == null) missing.push('uv');
  return {
    temp: hour.temp,
    code: hour.code,
    rain: hour.rain,
    wind: hour.wind,
    uv: hour.uv,
    hour: hour.h,
    sample: `${day.day} ${String(hour.h).padStart(2, '0')}:00`,
    missing
  };
}

export function mergeManualWeather(summary: WeatherSummary, manual?: ManualWeather | null): WeatherSummary & { manual: boolean } {
  const has = manual && [manual.temp, manual.rain, manual.wind, manual.uv, manual.condition].some((v) => v != null && v !== '');
  if (!has) return { ...summary, manual: false };
  const num = (v: any) => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    ...summary,
    temp: num(manual!.temp) ?? summary.temp,
    rain: num(manual!.rain) ?? summary.rain,
    wind: num(manual!.wind) ?? summary.wind,
    uv: num(manual!.uv) ?? summary.uv,
    missing: summary.missing.filter((key) => num(manual![key]) == null),
    manual: true
  };
}

const CODE_KEYS = new Map<number, string>([
  [0, 'clear'], [1, 'mostlyClear'], [2, 'partly'], [3, 'overcast'],
  [45, 'fog'], [48, 'fog'],
  [51, 'drizzle'], [53, 'drizzle'], [55, 'drizzle'], [56, 'drizzle'], [57, 'drizzle'],
  [61, 'rain'], [63, 'rain'], [65, 'rain'], [66, 'rain'], [67, 'rain'],
  [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'],
  [80, 'shower'], [81, 'shower'], [82, 'shower'],
  [85, 'snow'], [86, 'snow'],
  [95, 'thunder'], [96, 'thunder'], [99, 'thunder']
]);

export function weatherCodeKey(code: number | null) {
  if (code == null) return 'unknown';
  return CODE_KEYS.get(code) || 'unknown';
}

export function weatherIcon(code: number | null) {
  if (code == null) return '🌡️';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code === 45 || code === 48) return '🌫️';
  if (code >= 51 && code <= 67) return '🌧️';
  if ((code >= 71 && code <= 77) || code >= 85) return '🌨️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 95) return '⛈️';
  return '🌡️';
}

function cacheKey(lat: number, lon: number, day: string) {
  return `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)},${day}`;
}

function readCache(key: string): WeatherDay | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || !Array.isArray(value.hours) || !value.hours.length) return null;
    const ttl = value.model === 'forecast' ? 6 * 3600_000 : 90 * 86400_000;
    if (Date.now() - value.fetchedAt > ttl) return null;
    return value;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: WeatherDay) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

export function cachedWeatherDay(lat: number, lon: number, day: string) {
  const data = readCache(cacheKey(lat, lon, day));
  return data ? { data, cached: true } : null;
}

export function clearWeatherCache() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* ignore */ }
}

export type WeatherFetchOptions = {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  online?: boolean;
  cache?: boolean;
};

export async function fetchWeatherDay(lat: number, lon: number, day: string, opts: WeatherFetchOptions = {}) {
  const key = cacheKey(lat, lon, day);
  if (opts.cache !== false) {
    const cached = readCache(key);
    if (cached) return { data: cached, cached: true };
  }
  const online = opts.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  if (!online) throw new Error('weather-offline');
  const model = weatherModelFor(day);
  const url = weatherUrl(lat, lon, day, model);
  const fetchImpl = opts.fetchImpl || fetch;
  const ctrl = new AbortController();
  const abort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`weather-http-${res.status}`);
    const payload = await res.json();
    const data = parseWeatherPayload({ ...payload, source: WEATHER_SOURCE, model }, day);
    writeCache(key, data);
    return { data, cached: false };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }
}

export function weatherDisclosure(cached: boolean) {
  return cached ? 'cached' : 'network';
}
