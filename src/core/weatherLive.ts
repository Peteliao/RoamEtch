import { get } from './settings';
import { weatherCodeKey, type WeatherSummary } from './weather';

export type WeatherAlertLevel = 'warning' | 'severe' | 'extreme';
export type WeatherAlertKind = 'thunderstorm' | 'heavyRain' | 'snow' | 'wind' | 'heat' | 'cold' | 'official' | 'other';

export type WeatherAlert = {
  level: WeatherAlertLevel;
  kind: WeatherAlertKind;
  message?: string;
  official?: boolean;
  startsAt?: number;
  endsAt?: number;
  forecast?: boolean;
};

export type CurrentWeather = {
  lat: number;
  lon: number;
  sampledAt: number;
  fetchedAt: number;
  source: string;
  providerId: string;
  timezone: string;
  summary: WeatherSummary;
  alerts: WeatherAlert[];
  cached: boolean;
  latencyMs: number | null;
};

export type RecordedWeather = {
  time: number;
  lat: number;
  lon: number;
  source: string;
  providerId: string;
  summary: WeatherSummary;
  alerts: WeatherAlert[];
};

export type WeatherProbeResult = {
  id: string;
  ok: boolean;
  ms: number | null;
  error?: string;
};

export type WeatherRanking = {
  at: number;
  order: string[];
  results: WeatherProbeResult[];
};

export type WeatherProviderMode = 'auto' | 'cn' | 'global' | 'custom';

const CACHE_PREFIX = 'lt.weather.current.v2.';
const RANKING_KEY = 'lt.weather.ranking.v3.';
const LAST_LOCATION_KEY = 'lt.weather.location.v2.';
const RANKING_TTL = 6 * 3600_000;
const CURRENT_TTL = 20 * 60_000;
const REQUEST_TIMEOUT = 6500;
const MAX_CACHE_ENTRIES = 4;
export const WEATHER_SOURCE = 'Open-Meteo';
export const WEATHER_ATTRIBUTION = 'Open-Meteo · CC BY 4.0';

type ParsedWeather = Omit<CurrentWeather, 'lat' | 'lon' | 'fetchedAt' | 'cached' | 'latencyMs'>;

type Provider = {
  id: string;
  label: string;
  source: string;
  mode: 'global' | 'cn';
  fetch: (lat: number, lon: number, fetchImpl: typeof fetch, signal: AbortSignal) => Promise<ParsedWeather>;
};

const OPEN_METEO_FIELDS = 'temperature_2m,weather_code,precipitation,wind_speed_10m,wind_gusts_10m';
const OPEN_METEO_CURRENT = `${OPEN_METEO_FIELDS},rain,showers,snowfall,uv_index`;
const OPEN_METEO_HOURLY = 'temperature_2m,weather_code,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m';

function finite(value: any): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bounded(value: any, min: number, max: number): number | null {
  const n = finite(value);
  return n != null && n >= min && n <= max ? n : null;
}

function text(value: any, max = 160): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function summary(values: {
  temp?: any; code?: any; condition?: any; rain?: any; wind?: any; gust?: any;
  precipitation?: any; uv?: any; sample?: string;
}): WeatherSummary {
  const code = bounded(values.code, 0, 999);
  const condition = text(values.condition, 80);
  const rain = bounded(values.rain, 0, 100);
  const uv = bounded(values.uv, 0, 30);
  const missing: WeatherSummary['missing'] = [];
  if (rain == null) missing.push('rain');
  if (uv == null) missing.push('uv');
  if (values.temp == null && code == null && !condition) throw new Error('weather-empty');
  return {
    temp: bounded(values.temp, -100, 80),
    code,
    condition: condition || null,
    rain,
    wind: bounded(values.wind, 0, 500),
    gust: bounded(values.gust, 0, 500),
    precipitation: bounded(values.precipitation, 0, 1000),
    uv,
    hour: 12,
    sample: values.sample || '',
    missing
  };
}

function parseTime(value: any, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clock(iso: string, fallback: number): { time: number; sample: string } {
  const time = parseTime(iso, fallback);
  const match = /T(\d{2}):/.exec(String(iso || ''));
  return { time, sample: match ? `${String(iso).slice(0, 10)} ${match[1]}:00` : '' };
}

function hourlyValueAt(payload: any, time: number, field: string): number | null {
  const times = payload?.hourly?.time;
  const values = payload?.hourly?.[field];
  if (!Array.isArray(times) || !Array.isArray(values) || !times.length) return null;
  let index = times.findIndex((value) => parseTime(value, time) >= time - 60_000);
  if (index < 0) index = times.length - 1;
  return values[index];
}

function withSampleHour(value: WeatherSummary): WeatherSummary {
  const hour = Number(value.sample.slice(11, 13));
  return { ...value, hour: Number.isFinite(hour) ? hour : value.hour };
}

function rankAlert(level: WeatherAlertLevel): number {
  return level === 'extreme' ? 3 : level === 'severe' ? 2 : 1;
}

export function primaryWeatherAlert(alerts: WeatherAlert[] = []): WeatherAlert | null {
  return alerts.reduce<WeatherAlert | null>((best, alert) =>
    !best || rankAlert(alert.level) > rankAlert(best.level) ? alert : best, null);
}

export function assessWeatherAlert(values: {
  code?: number | null; rain?: number | null; wind?: number | null; gust?: number | null;
  precipitation?: number | null; temp?: number | null;
}, forecast = false): WeatherAlert | null {
  const code = values.code ?? null;
  const rain = values.rain ?? null;
  const wind = values.wind ?? null;
  const gust = values.gust ?? null;
  const precipitation = values.precipitation ?? null;
  const temp = values.temp ?? null;
  let alert: WeatherAlert | null = null;
  const offer = (next: WeatherAlert) => {
    if (!alert || rankAlert(next.level) > rankAlert(alert.level)) alert = next;
  };
  if (code != null && code >= 95) offer({ level: code >= 97 ? 'extreme' : 'severe', kind: 'thunderstorm', forecast });
  if (code === 82 || (precipitation != null && precipitation >= 30) || (code != null && code >= 65 && code <= 67 && precipitation != null && precipitation >= 15)) {
    offer({ level: 'extreme', kind: 'heavyRain', forecast });
  } else if (code === 65 || code === 67 || (precipitation != null && precipitation >= 10)) {
    offer({ level: 'severe', kind: 'heavyRain', forecast });
  } else if (rain != null && rain >= 80 && code != null && ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))) {
    offer({ level: 'warning', kind: 'heavyRain', forecast });
  }
  if (code === 75 || code === 86 || (code != null && code >= 71 && code <= 77 && precipitation != null && precipitation >= 5)) {
    offer({ level: 'severe', kind: 'snow', forecast });
  }
  if ((gust != null && gust >= 120) || (wind != null && wind >= 110)) offer({ level: 'extreme', kind: 'wind', forecast });
  else if ((gust != null && gust >= 90) || (wind != null && wind >= 62)) offer({ level: 'severe', kind: 'wind', forecast });
  else if ((gust != null && gust >= 70) || (wind != null && wind >= 50)) offer({ level: 'warning', kind: 'wind', forecast });
  if (temp != null && (temp >= 40 || temp <= -20)) offer({ level: 'extreme', kind: temp >= 40 ? 'heat' : 'cold', forecast });
  else if (temp != null && (temp >= 35 || temp <= -10)) offer({ level: 'warning', kind: temp >= 35 ? 'heat' : 'cold', forecast });
  return alert;
}

function openMeteoAlerts(payload: any, fallback: ParsedWeather['summary']): WeatherAlert[] {
  const alerts: WeatherAlert[] = [];
  const current = assessWeatherAlert(fallback);
  if (current) alerts.push(current);
  const hourly = payload?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) return alerts;
  const now = Date.now();
  let forecast: WeatherAlert | null = null;
  for (let i = 0; i < hourly.time.length; i++) {
    const at = parseTime(hourly.time[i], now);
    if (at < now || at > now + 3 * 3600_000) continue;
    const next = assessWeatherAlert({
      code: hourly.weather_code?.[i], rain: hourly.precipitation_probability?.[i],
      wind: hourly.wind_speed_10m?.[i], gust: hourly.wind_gusts_10m?.[i],
      precipitation: hourly.precipitation?.[i], temp: hourly.temperature_2m?.[i]
    }, true);
    if (!next) continue;
    next.startsAt = at;
    if (!forecast || rankAlert(next.level) > rankAlert(forecast.level)) forecast = next;
  }
  if (forecast) alerts.push(forecast);
  return alerts;
}

async function parseOpenMeteo(res: Response, model: 'best_match' | 'cma'): Promise<ParsedWeather> {
  const payload = await res.json();
  if (payload?.error) throw new Error('weather-provider-error');
  const current = payload?.current || {};
  let picked = current;
  if (model === 'cma' || (!Object.keys(current).length && Array.isArray(payload?.hourly?.time))) {
    const times: any[] = payload?.hourly?.time || [];
    const now = Date.now();
    let index = times.findIndex((value) => parseTime(value, now) >= now - 30 * 60_000);
    if (index < 0) index = 0;
    const at = times[index];
    const stamp = clock(String(at || ''), now);
    picked = {
      time: at,
      temperature_2m: payload?.hourly?.temperature_2m?.[index],
      weather_code: payload?.hourly?.weather_code?.[index],
      precipitation: payload?.hourly?.precipitation?.[index],
      wind_speed_10m: payload?.hourly?.wind_speed_10m?.[index],
      wind_gusts_10m: payload?.hourly?.wind_gusts_10m?.[index]
    };
    const fallback = withSampleHour(summary({
      temp: picked.temperature_2m, code: picked.weather_code, precipitation: picked.precipitation,
      wind: picked.wind_speed_10m, gust: picked.wind_gusts_10m, sample: stamp.sample
    }));
    return {
      sampledAt: stamp.time, source: model === 'cma' ? 'Open-Meteo · CMA GRAPES' : WEATHER_SOURCE,
      providerId: model === 'cma' ? 'open-meteo-cma' : 'open-meteo',
      timezone: text(payload?.timezone, 80), summary: fallback, alerts: openMeteoAlerts(payload, fallback)
    };
  }
  const stamp = clock(String(current.time || ''), Date.now());
  const parsed = withSampleHour(summary({
    temp: current.temperature_2m, code: current.weather_code,
    rain: current.precipitation_probability ?? hourlyValueAt(payload, stamp.time, 'precipitation_probability'),
    wind: current.wind_speed_10m, gust: current.wind_gusts_10m,
    precipitation: current.precipitation, uv: current.uv_index, sample: stamp.sample
  }));
  return {
    sampledAt: stamp.time, source: WEATHER_SOURCE, providerId: 'open-meteo',
    timezone: text(payload?.timezone, 80), summary: parsed, alerts: openMeteoAlerts(payload, parsed)
  };
}

async function fetchOpenMeteo(lat: number, lon: number, fetchImpl: typeof fetch, signal: AbortSignal, cma = false) {
  const base = cma ? 'https://api.open-meteo.com/v1/cma' : 'https://api.open-meteo.com/v1/forecast';
  const params = new URLSearchParams({
    latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto',
    ...(cma
      ? { hourly: OPEN_METEO_FIELDS, forecast_hours: '6', forecast_days: '1' }
      : { current: OPEN_METEO_CURRENT, hourly: OPEN_METEO_HOURLY, forecast_days: '1' })
  });
  const res = await fetchImpl(`${base}?${params}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`weather-http-${res.status}`);
  return parseOpenMeteo(res, cma ? 'cma' : 'best_match');
}

function readPath(root: any, path: string): any {
  if (!path) return undefined;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let value = root;
  for (const part of parts) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

function firstPath(root: any, paths: string[]): any {
  for (const path of paths) {
    const value = readPath(root, path);
    if (value != null) return value;
  }
  return undefined;
}

function customMapping(): Record<string, string> {
  const raw = text(get('weatherCustomMapping'), 12000);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const mapping: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') mapping[key] = value;
    }
    return mapping;
  } catch {
    throw new Error('weather-custom-mapping');
  }
}

function customHeaders(): Record<string, string> {
  const raw = text(get('weatherCustomHeaders'), 8000);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string' && typeof value !== 'number') continue;
      if (/^(host|content-length|connection|origin|referer)$/i.test(key)) continue;
      headers[key] = String(value).slice(0, 1000);
    }
    return headers;
  } catch {
    throw new Error('weather-custom-headers');
  }
}

function customUrl(lat: number, lon: number): string {
  const template = text(get('weatherCustomUrl'), 4000);
  if (!template) throw new Error('weather-custom-url');
  const key = text(get('weatherCustomKey'), 2000);
  let raw = template.replaceAll('{lat}', lat.toFixed(4)).replaceAll('{lon}', lon.toFixed(4))
    .replaceAll('{key}', encodeURIComponent(key));
  let url: URL;
  try { url = new URL(raw, location.href); } catch { throw new Error('weather-custom-url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('weather-custom-url');
  if (!template.includes('{lat}') && !/[?&](latitude|lat)=/i.test(template)) url.searchParams.set('latitude', lat.toFixed(4));
  if (!template.includes('{lon}') && !/[?&](longitude|lon)=/i.test(template)) url.searchParams.set('longitude', lon.toFixed(4));
  if (key && !template.includes('{key}')) url.searchParams.set('key', key);
  return url.toString();
}

function alertLevel(value: any): WeatherAlertLevel {
  const v = text(value, 40).toLowerCase();
  if (['extreme', 'critical', 'red', '4', 'severe'].includes(v)) return v === 'severe' ? 'severe' : 'extreme';
  if (['warning', 'orange', 'yellow', 'moderate', '2', '3'].includes(v)) return 'warning';
  if (['info', 'minor', 'blue', '1'].includes(v)) return 'warning';
  return 'warning';
}

function alertKind(value: any): WeatherAlertKind {
  const v = text(value, 60).toLowerCase();
  if (/thunder|storm|雷|暴/.test(v)) return 'thunderstorm';
  if (/rain|flood|雨|洪/.test(v)) return 'heavyRain';
  if (/snow|ice|雪|冰/.test(v)) return 'snow';
  if (/wind|gale|风/.test(v)) return 'wind';
  if (/heat|hot|高温|热/.test(v)) return 'heat';
  if (/cold|freez|寒|冷/.test(v)) return 'cold';
  return 'official';
}

function conditionCode(value: any): { code: number | null; condition: string } {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    return { code: bounded(value, 0, 999), condition: '' };
  }
  const condition = text(value, 80);
  const key = condition.toLowerCase();
  const known = conditions.find((entry) => entry.words.some((word) => key.includes(word)));
  return { code: known?.code ?? null, condition };
}

const conditions = [
  { code: 95, words: ['thunder', '雷'] }, { code: 82, words: ['violent', '暴雨', '特大'] },
  { code: 65, words: ['heavy rain', '大雨'] }, { code: 61, words: ['rain', '雨'] },
  { code: 75, words: ['heavy snow', '大雪'] }, { code: 71, words: ['snow', '雪'] },
  { code: 45, words: ['fog', '雾'] }, { code: 3, words: ['overcast', '阴'] },
  { code: 2, words: ['partly', '多云'] }, { code: 1, words: ['mostly clear', '晴间'] },
  { code: 0, words: ['clear', 'sunny', '晴'] }
];

async function fetchCustom(lat: number, lon: number, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ParsedWeather> {
  const mapping = customMapping();
  const res = await fetchImpl(customUrl(lat, lon), { signal, headers: customHeaders(), cache: 'no-store' });
  if (!res.ok) throw new Error(`weather-http-${res.status}`);
  const payload = await res.json();
  const root = Array.isArray(payload) ? payload[0] : payload;
  if (!root || typeof root !== 'object') throw new Error('weather-custom-payload');
  const pick = (name: string, ...fallbacks: string[]) => firstPath(root, [mapping[name], ...fallbacks].filter(Boolean));
  const condition = conditionCode(pick('condition', 'current.weather_code', 'weather_code', 'condition', 'data.condition'));
  const stamp = clock(String(pick('time', 'current.time', 'time', 'data.time') || ''), Date.now());
  const parsed = summary({
    temp: pick('temperature', 'current.temperature_2m', 'temperature_2m', 'temperature', 'data.temperature'),
    code: pick('weatherCode', 'current.weather_code', 'weather_code') ?? condition.code,
    condition: condition.condition,
    rain: pick('rainProbability', 'current.precipitation_probability', 'precipitation_probability', 'rainProbability'),
    wind: pick('windSpeed', 'current.wind_speed_10m', 'wind_speed_10m', 'windSpeed'),
    gust: pick('gust', 'current.wind_gusts_10m', 'wind_gusts_10m', 'gust'),
    precipitation: pick('precipitation', 'current.precipitation', 'precipitation'),
    uv: pick('uvIndex', 'current.uv_index', 'uv_index', 'uvIndex'), sample: stamp.sample
  });
  const alerts: WeatherAlert[] = [];
  const derived = assessWeatherAlert(parsed);
  if (derived) alerts.push(derived);
  const mappedAlerts = pick('alerts', 'alerts', 'data.alerts');
  if (Array.isArray(mappedAlerts)) {
    for (const item of mappedAlerts.slice(0, 10)) {
      if (!item || typeof item !== 'object') continue;
      const level = alertLevel(firstPath(item, [mapping['alertLevel'], 'level', 'severity', 'Level'].filter(Boolean)));
      alerts.push({
        level, kind: alertKind(firstPath(item, [mapping['alertKind'], 'kind', 'event', 'Type'].filter(Boolean))),
        message: text(firstPath(item, [mapping['alertMessage'], 'message', 'event', 'Text'].filter(Boolean))),
        startsAt: parseTime(firstPath(item, ['start', 'onset', 'StartTime']), stamp.time),
        endsAt: parseTime(firstPath(item, ['end', 'expires', 'EndTime']), stamp.time),
        official: true
      });
    }
  } else {
    const levelValue = pick('alertLevel', 'alertLevel', 'alert.level', 'data.alertLevel');
    if (levelValue != null && levelValue !== '') {
      alerts.push({
        level: alertLevel(levelValue), kind: alertKind(pick('alertKind', 'alertKind', 'alert.kind')),
        message: text(pick('alertMessage', 'alertMessage', 'alert.message', 'data.alertMessage')),
        startsAt: parseTime(pick('alertStart', 'alert.start'), stamp.time),
        endsAt: parseTime(pick('alertEnd', 'alert.end'), stamp.time), official: true
      });
    }
  }
  return {
    sampledAt: stamp.time, source: text(pick('source', 'source', 'data.source'), 80) || 'Custom weather API',
    providerId: 'custom', timezone: text(pick('timezone', 'timezone', 'data.timezone'), 80),
    summary: parsed, alerts
  };
}

export const weatherProviders: Provider[] = [
  {
    id: 'open-meteo', label: 'Open-Meteo Global', source: WEATHER_SOURCE, mode: 'global',
    fetch: (lat, lon, fetchImpl, signal) => fetchOpenMeteo(lat, lon, fetchImpl, signal)
  },
  {
    id: 'open-meteo-cma', label: 'Open-Meteo · CMA GRAPES', source: 'Open-Meteo · CMA GRAPES', mode: 'cn',
    fetch: (lat, lon, fetchImpl, signal) => fetchOpenMeteo(lat, lon, fetchImpl, signal, true)
  },
  {
    id: 'custom', label: 'Custom weather API', source: 'Custom weather API', mode: 'cn',
    fetch: fetchCustom
  }
];

export function configuredWeatherProviders(mode = get('weatherProviderMode') || 'auto'): Provider[] {
  const hasCustom = !!text(get('weatherCustomUrl'), 4000);
  if (mode === 'custom') return hasCustom ? [weatherProviders[2]] : [];
  if (mode === 'cn') return [...(hasCustom ? [weatherProviders[2]] : []), weatherProviders[1]];
  if (mode === 'global') return [weatherProviders[0]];
  return [...(hasCustom ? [weatherProviders[2]] : []), weatherProviders[0], weatherProviders[1]];
}

function cacheKey(lat: number, lon: number) {
  return `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)}`;
}

export function readCurrentWeatherCache(lat: number, lon: number, { allowStale = true } = {}): CurrentWeather | null {
  try {
    const raw = localStorage.getItem(cacheKey(lat, lon));
    if (!raw) return null;
    const value = JSON.parse(raw) as CurrentWeather;
    if (!value?.summary || !Number.isFinite(value.fetchedAt)) return null;
    if (!allowStale && Date.now() - value.fetchedAt > CURRENT_TTL) return null;
    return { ...value, cached: true };
  } catch {
    return null;
  }
}

function writeCurrentWeatherCache(value: CurrentWeather) {
  try {
    localStorage.setItem(cacheKey(value.lat, value.lon), JSON.stringify({ ...value, cached: false }));
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    if (keys.length <= MAX_CACHE_ENTRIES) return;
    const ordered = keys.map((key) => {
      try { return { key, at: JSON.parse(localStorage.getItem(key) || '{}').fetchedAt || 0 }; }
      catch { return { key, at: 0 }; }
    }).sort((a, b) => b.at - a.at);
    for (const entry of ordered.slice(MAX_CACHE_ENTRIES)) localStorage.removeItem(entry.key);
  } catch { /* storage may be unavailable */ }
}

export function readWeatherRanking(mode = get('weatherProviderMode') || 'auto'): WeatherRanking | null {
  try {
    const value = JSON.parse(localStorage.getItem(RANKING_KEY + mode) || 'null') as WeatherRanking;
    if (!value || !Number.isFinite(value.at) || Date.now() - value.at > RANKING_TTL || !Array.isArray(value.order)) return null;
    return value;
  } catch {
    return null;
  }
}

function writeWeatherRanking(mode: string, results: WeatherProbeResult[]) {
  const successful = results.filter((result) => result.ok && result.ms != null).sort((a, b) => a.ms! - b.ms!);
  const failed = results.filter((result) => !result.ok);
  const value: WeatherRanking = { at: Date.now(), order: successful.map((result) => result.id), results };
  try { localStorage.setItem(`${RANKING_KEY}${mode}`, JSON.stringify(value)); } catch { /* ignore */ }
  return value;
}

async function requestProvider(provider: Provider, lat: number, lon: number, fetchImpl: typeof fetch, signal: AbortSignal) {
  const started = performance.now();
  try {
    const parsed = await provider.fetch(lat, lon, fetchImpl, signal);
    return {
      value: { ...parsed, lat, lon, fetchedAt: Date.now(), cached: false, latencyMs: Math.max(1, Math.round(performance.now() - started)) } as CurrentWeather,
      result: { id: provider.id, ok: true, ms: Math.max(1, Math.round(performance.now() - started)) } as WeatherProbeResult
    };
  } catch (error) {
    return {
      value: null,
      result: { id: provider.id, ok: false, ms: null, error: String(error?.message || error).slice(0, 80) } as WeatherProbeResult
    };
  }
}

export type CurrentWeatherOptions = {
  fetchImpl?: typeof fetch;
  online?: boolean;
  cache?: boolean;
  force?: boolean;
  probe?: boolean;
  mode?: WeatherProviderMode;
  signal?: AbortSignal;
};

export async function fetchCurrentWeather(lat: number, lon: number, opts: CurrentWeatherOptions = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('weather-location');
  if (opts.cache !== false && !opts.force) {
    const cached = readCurrentWeatherCache(lat, lon, { allowStale: false });
    if (cached) return { data: cached, ranking: readWeatherRanking(opts.mode) };
  }
  const online = opts.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  const mode = opts.mode || get('weatherProviderMode') || 'auto';
  const providers = configuredWeatherProviders(mode);
  if (!providers.length) throw new Error('weather-provider-unconfigured');
  if (!online) {
    const cached = opts.cache === false ? null : readCurrentWeatherCache(lat, lon);
    if (cached) return { data: cached, ranking: readWeatherRanking(mode) };
    throw new Error('weather-offline');
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const probe = opts.probe ?? false;
  const ranking = readWeatherRanking(mode);
  let results: WeatherProbeResult[] = [];
  let winner: CurrentWeather | null = null;
  if (probe) {
    const settled = await Promise.all(providers.map(async (provider) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const abort = () => controller.abort(opts.signal?.reason);
      opts.signal?.addEventListener('abort', abort, { once: true });
      try { return await requestProvider(provider, lat, lon, fetchImpl, controller.signal); }
      finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
    }));
    results = settled.map((entry) => entry.result);
    winner = settled.filter((entry) => entry.value).sort((a, b) => (a.value!.latencyMs || 0) - (b.value!.latencyMs || 0))[0]?.value || null;
    writeWeatherRanking(mode, results);
  } else {
    const ordered = ranking
      ? [...providers].sort((a, b) => {
        const ai = ranking.order.indexOf(a.id), bi = ranking.order.indexOf(b.id);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      })
      : providers;
    for (const provider of ordered) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
      const abort = () => controller.abort(opts.signal?.reason);
      opts.signal?.addEventListener('abort', abort, { once: true });
      try {
        const attempt = await requestProvider(provider, lat, lon, fetchImpl, controller.signal);
        results.push(attempt.result);
        if (attempt.value) { winner = attempt.value; break; }
      } finally { clearTimeout(timer); opts.signal?.removeEventListener('abort', abort); }
    }
    if (winner) writeWeatherRanking(mode, results);
  }
  if (!winner) {
    const cached = opts.cache === false ? null : readCurrentWeatherCache(lat, lon);
    if (cached) return { data: cached, ranking: { at: Date.now(), order: [], results } };
    throw new Error(results.find((result) => result.error?.includes('custom'))?.error || 'weather-unavailable');
  }
  writeCurrentWeatherCache(winner);
  return { data: winner, ranking: readWeatherRanking(mode) || { at: Date.now(), order: [winner.providerId], results } };
}

export function normalizeWeatherLog(value: any): RecordedWeather[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const records: RecordedWeather[] = [];
  for (const item of value) {
    const time = finite(item?.time);
    const lat = bounded(item?.lat, -90, 90), lon = bounded(item?.lon, -180, 180);
    if (time == null || lat == null || lon == null || !item?.summary || typeof item.summary !== 'object') continue;
    const alerts = Array.isArray(item.alerts) ? item.alerts.filter((alert) => alert && ['warning', 'severe', 'extreme'].includes(alert.level)).slice(0, 10) : [];
    const source = text(item.source, 80) || WEATHER_SOURCE;
    const key = `${Math.round(time / 60000)}:${lat.toFixed(2)}:${lon.toFixed(2)}:${source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      time, lat, lon, source, providerId: text(item.providerId, 60) || 'legacy',
      summary: {
        temp: bounded(item.summary.temp, -100, 80), code: bounded(item.summary.code, 0, 999),
        condition: text(item.summary.condition, 80) || null,
        rain: bounded(item.summary.rain, 0, 100), wind: bounded(item.summary.wind, 0, 500),
        gust: bounded(item.summary.gust, 0, 500), precipitation: bounded(item.summary.precipitation, 0, 1000),
        uv: bounded(item.summary.uv, 0, 30), hour: finite(item.summary.hour) ?? 12,
        sample: text(item.summary.sample, 80),
        missing: Array.isArray(item.summary.missing) ? item.summary.missing.filter((key) => key === 'rain' || key === 'uv') : []
      },
      alerts
    });
  }
  return records.sort((a, b) => a.time - b.time);
}

export function closestRecordedWeather(samples: RecordedWeather[], time?: number | null): RecordedWeather | null {
  if (!samples.length) return null;
  if (!Number.isFinite(time)) return samples.reduce((best, item) => item.alerts.length && !best.alerts.length ? item : best, samples[0]);
  return samples.reduce((best, item) => Math.abs(item.time - time!) < Math.abs(best.time - time!) ? item : best, samples[0]);
}

export function weatherConditionLabelKey(summary: Pick<WeatherSummary, 'code'>) {
  return `story.codes.${weatherCodeKey(summary.code)}`;
}

export function rememberWeatherLocation(lat: number, lon: number) {
  try { localStorage.setItem(LAST_LOCATION_KEY, JSON.stringify({ lat, lon })); } catch { /* ignore */ }
}

export function readWeatherLocation(): { lat: number; lon: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_LOCATION_KEY) || 'null');
    return value && Number.isFinite(value.lat) && Number.isFinite(value.lon) ? value : null;
  } catch {
    return null;
  }
}
