import { emit, on } from './events';
import { haversine } from './geo';
import { rec } from './recorder';
import { get } from './settings';
import { appendTripWeatherSample } from './store';
import {
  fetchCurrentWeather, primaryWeatherAlert, readCurrentWeatherCache, readWeatherLocation,
  readWeatherRanking, rememberWeatherLocation,
  type CurrentWeather, type RecordedWeather, type WeatherRanking
} from './weatherLive';

export type WeatherMonitorState = {
  location: { lat: number; lon: number; at: number } | null;
  current: CurrentWeather | null;
  fetching: boolean;
  error: string | null;
  ranking: WeatherRanking | null;
};

export const weatherState: WeatherMonitorState = {
  location: null, current: null, fetching: false, error: null, ranking: null
};

export type WeatherRefreshOptions = { force?: boolean; probe?: boolean };
let initialized = false;
let inFlight: Promise<CurrentWeather | null> | null = null;
let queued: WeatherRefreshOptions | null = null;
let lastAttemptAt = 0;
let configVersion = 0;
let lastAlertKey = '';
let lastAlertAt = 0;
const RECORDING_SAMPLE_MS = 15 * 60_000;
const WEATHER_MOVE_MS = 5000;
const ALERT_COOLDOWN_MS = 30 * 60_000;

function validLocation(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function activeRecordingTrip() {
  return rec.status === 'recording' || rec.status === 'paused' ? rec.tripId : null;
}

function notifyChanged() {
  emit('weather:changed', {
    current: weatherState.current,
    fetching: weatherState.fetching,
    error: weatherState.error,
    ranking: weatherState.ranking,
    location: weatherState.location
  });
}

function notifyAlert(current: CurrentWeather) {
  if (!get('weatherAlertEnabled')) return;
  const alert = primaryWeatherAlert(current.alerts);
  if (!alert) {
    lastAlertKey = '';
    return;
  }
  const key = `${current.providerId}:${alert.kind}:${alert.level}:${alert.startsAt || current.sampledAt}`;
  const now = Date.now();
  if (key === lastAlertKey && now - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertKey = key;
  lastAlertAt = now;
  emit('weather:alert', { alert, current });
}

async function performRefresh(options: WeatherRefreshOptions, version: number): Promise<CurrentWeather | null> {
  const location = weatherState.location;
  if (!location || !get('weatherEnabled') || !validLocation(location.lat, location.lon)) return null;
  const tripId = activeRecordingTrip();
  weatherState.fetching = true;
  weatherState.error = null;
  lastAttemptAt = Date.now();
  notifyChanged();
  try {
    const result = await fetchCurrentWeather(location.lat, location.lon, { force: options.force || options.probe, probe: options.probe });
    if (version !== configVersion || !get('weatherEnabled')) return result.data;
    weatherState.current = result.data;
    weatherState.ranking = result.ranking;
    weatherState.error = null;
    lastAttemptAt = Date.now();
    notifyChanged();
    notifyAlert(result.data);
    if (tripId && get('weatherEnabled')) {
      const sample: RecordedWeather = {
        time: result.data.sampledAt,
        lat: result.data.lat,
        lon: result.data.lon,
        source: result.data.source,
        providerId: result.data.providerId,
        summary: result.data.summary,
        alerts: result.data.alerts
      };
      await appendTripWeatherSample(tripId, sample).catch(() => false);
    }
    return result.data;
  } catch (error) {
    if (version === configVersion) {
      weatherState.error = String(error?.message || error).slice(0, 100);
      notifyChanged();
    }
    return weatherState.current;
  } finally {
    weatherState.fetching = false;
    notifyChanged();
    const next = queued;
    queued = null;
    if (next) setTimeout(() => { void refreshWeather(next); }, 0);
  }
}

export function refreshWeather(options: WeatherRefreshOptions = {}): Promise<CurrentWeather | null> {
  if (!get('weatherEnabled') || !weatherState.location) return Promise.resolve(weatherState.current);
  if (inFlight) {
    queued = {
      force: !!(options.force || queued?.force),
      probe: !!(options.probe || queued?.probe)
    };
    return inFlight;
  }
  const version = configVersion;
  const job = performRefresh(options, version).finally(() => {
    if (inFlight === job) inFlight = null;
  });
  inFlight = job;
  return job;
}

export function updateWeatherLocation(lat: number, lon: number, options: WeatherRefreshOptions & { remember?: boolean } = {}) {
  if (!validLocation(lat, lon)) return;
  const previous = weatherState.location;
  const moved = !previous || haversine(previous.lat, previous.lon, lat, lon) >= WEATHER_MOVE_MS;
  weatherState.location = { lat, lon, at: Date.now() };
  if (options.remember !== false) rememberWeatherLocation(lat, lon);
  if (!weatherState.current || moved) {
    weatherState.current = readCurrentWeatherCache(lat, lon);
    weatherState.ranking = readWeatherRanking();
    notifyChanged();
  }
  if (!get('weatherEnabled')) return;
  const stale = !weatherState.current || Date.now() - weatherState.current.fetchedAt > 20 * 60_000;
  if (options.force || options.probe || moved || stale) {
    void refreshWeather({ force: options.force || moved, probe: options.probe || !weatherState.ranking });
  }
}

export function initWeatherMonitor() {
  if (initialized) return;
  initialized = true;
  const location = readWeatherLocation();
  if (location) {
    weatherState.location = { ...location, at: Date.now() };
    weatherState.current = readCurrentWeatherCache(location.lat, location.lon);
    weatherState.ranking = readWeatherRanking();
  }

  on('recorder:started', ({ tripId }) => {
    if (rec.live?.lat != null && rec.live?.lon != null) updateWeatherLocation(rec.live.lat, rec.live.lon);
    else if (!weatherState.location && tripId) return;
    void refreshWeather({ force: true, probe: true });
  });
  on('recorder:point', ({ point }) => {
    if (validLocation(point?.lat, point?.lon)) updateWeatherLocation(point.lat, point.lon, { remember: false });
  });
  on('recorder:tick', ({ live }) => {
    if (validLocation(live?.lat, live?.lon) && weatherState.location
      && haversine(weatherState.location.lat, weatherState.location.lon, live.lat, live.lon) >= WEATHER_MOVE_MS) {
      updateWeatherLocation(live.lat, live.lon, { remember: false });
    }
    if (activeRecordingTrip() && Date.now() - lastAttemptAt >= RECORDING_SAMPLE_MS) {
      void refreshWeather({ force: true });
    }
  });
  on('settings:changed', ({ key, keys, reset }) => {
    const relevant = reset || key === 'weatherEnabled' || key === 'weatherAlertEnabled'
      || key === 'weatherProviderMode' || key === 'weatherCustomUrl' || key === 'weatherCustomKey'
      || key === 'weatherCustomHeaders' || key === 'weatherCustomMapping'
      || keys?.some((name) => String(name).startsWith('weather'));
    if (!relevant) return;
    configVersion++;
    if (key === 'weatherAlertEnabled' && get('weatherAlertEnabled') && weatherState.current) notifyAlert(weatherState.current);
    const providerChanged = reset || key === 'weatherProviderMode' || key === 'weatherEnabled'
      || String(key || '').startsWith('weatherCustom');
    if (get('weatherEnabled') && weatherState.location) void refreshWeather({ force: true, probe: providerChanged });
    else notifyChanged();
  });
  on('network:online', () => {
    if (weatherState.location) void refreshWeather({ force: true });
  });
  on('network:offline', notifyChanged);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
    if (!document.hidden && get('weatherEnabled')) void refreshWeather();
  });
}
