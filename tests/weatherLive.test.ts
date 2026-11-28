// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSettings, set } from '../src/core/settings';
import {
  assessWeatherAlert, fetchCurrentWeather, normalizeWeatherLog, primaryWeatherAlert,
  weatherConditionLabelKey, type RecordedWeather
} from '../src/core/weatherLive';

function response(payload: any, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

function openMeteoPayload(overrides: any = {}) {
  const now = Date.now();
  const time = new Date(now).toISOString();
  return {
    timezone: 'Asia/Shanghai',
    current: {
      time, temperature_2m: 22, weather_code: 1, precipitation: 0,
      wind_speed_10m: 8, wind_gusts_10m: 14, uv_index: 3
    },
    hourly: {
      time: [time], temperature_2m: [22], weather_code: [1],
      precipitation: [0], precipitation_probability: [10],
      wind_speed_10m: [8], wind_gusts_10m: [14]
    },
    ...overrides
  };
}

function sample(time = Date.now(), overrides: Partial<RecordedWeather> = {}): RecordedWeather {
  return {
    time, lat: 30, lon: 120, source: 'Open-Meteo', providerId: 'open-meteo',
    summary: {
      temp: 22, code: 1, condition: null, rain: 10, wind: 8, gust: 14,
      precipitation: 0, uv: 3, hour: 12, sample: '', missing: []
    },
    alerts: [],
    ...overrides
  };
}

beforeEach(() => {
  localStorage.clear();
  resetSettings();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('live weather providers', () => {
  it('parses Open-Meteo current conditions and keeps probability in the hourly request', async () => {
    const fetchMock = vi.fn(async (_input: any, _init?: any) => response(openMeteoPayload()));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, mode: 'global' });

    expect(result.data.providerId).toBe('open-meteo');
    expect(result.data.summary.temp).toBe(22);
    expect(result.data.summary.rain).toBe(10);
    expect(result.data.summary.gust).toBe(14);
    expect(result.data.latencyMs).toBeGreaterThan(0);
    const url = String(fetchMock.mock.calls[0][0]);
    const params = new URL(url).searchParams;
    expect(params.get('current')).toContain('uv_index');
    expect(params.get('current')).not.toContain('precipitation_probability');
    expect(params.get('hourly')).toContain('precipitation_probability');
  });

  it('selects the nearest CMA hourly sample without requesting unsupported current fields', async () => {
    const now = Date.now();
    const times = [new Date(now - 3600_000).toISOString(), new Date(now).toISOString()];
    const fetchMock = vi.fn(async (_input: any, _init?: any) => response({
      timezone: 'Asia/Shanghai',
      hourly: {
        time: times, temperature_2m: [8, 18], weather_code: [3, 61],
        precipitation: [0, 2], wind_speed_10m: [4, 9], wind_gusts_10m: [7, 15]
      }
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, mode: 'cn' });
    expect(result.data.providerId).toBe('open-meteo-cma');
    expect(result.data.summary.temp).toBe(18);
    expect(result.data.summary.code).toBe(61);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe('/v1/cma');
    expect(url.searchParams.has('current')).toBe(false);
    expect(url.searchParams.get('hourly')).toContain('weather_code');
  });

  it('supports custom URL placeholders, filtered headers, field mappings and official alerts', async () => {
    set('weatherCustomUrl', 'https://weather.test/api?lat={lat}&lon={lon}&key={key}');
    set('weatherCustomKey', 'a b&c');
    set('weatherCustomHeaders', JSON.stringify({ Authorization: 'Bearer secret', Host: 'blocked.test' }));
    set('weatherCustomMapping', JSON.stringify({
      temperature: 'data.items[0].temp', weatherCode: 'data.items[0].code',
      alerts: 'data.alerts', alertLevel: 'severity'
    }));
    const fetchMock = vi.fn(async (_input: any, _init?: any) => response({
      data: {
        items: [{ temp: 17, code: 61 }],
        alerts: [{ severity: 'red', event: '雷暴大风', message: 'Stay indoors' }]
      }
    }));
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, mode: 'custom' });
    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(String(input));
    expect(url.searchParams.get('lat')).toBe('30.0000');
    expect(url.searchParams.get('lon')).toBe('120.0000');
    expect(url.searchParams.get('key')).toBe('a b&c');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect((init?.headers as Record<string, string>).Host).toBeUndefined();
    expect(result.data.summary.temp).toBe(17);
    expect(result.data.alerts).toContainEqual(expect.objectContaining({
      level: 'extreme', kind: 'thunderstorm', official: true, message: 'Stay indoors'
    }));
  });

  it.each([
    'javascript:alert(1)',
    'https://user:pass@weather.test/api',
    'https://weather.test/api#secret'
  ])('rejects unsafe custom URLs before fetching: %s', async (url) => {
    set('weatherCustomUrl', url);
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(fetchCurrentWeather(30, 120, {
      fetchImpl, cache: false, force: true, mode: 'custom'
    })).rejects.toThrow('weather-custom-url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('speed-tests global, CMA and custom providers and chooses the fastest valid response', async () => {
    set('weatherCustomUrl', 'https://weather.test/api');
    const fetchImpl = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.startsWith('https://weather.test')) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return response({ temperature: 12, weather_code: 2 });
      }
      if (url.includes('/v1/cma')) return response(openMeteoPayload());
      await new Promise((resolve) => setTimeout(resolve, 15));
      return response(openMeteoPayload());
    }) as unknown as typeof fetch;

    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, probe: true, mode: 'auto' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.data.providerId).toBe('open-meteo-cma');
    expect(result.ranking?.order).toEqual(['open-meteo-cma', 'open-meteo', 'custom']);
    expect(result.ranking?.results.every((entry) => entry.ok)).toBe(true);
  });

  it('falls back to a valid provider when the fastest candidate fails', async () => {
    set('weatherCustomUrl', 'https://weather.test/api');
    const fetchImpl = vi.fn(async (input: any) => {
      const url = String(input);
      return url.startsWith('https://weather.test') || url.includes('/v1/cma')
        ? response({}, 503)
        : response(openMeteoPayload());
    }) as unknown as typeof fetch;

    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, probe: true, mode: 'auto' });
    expect(result.data.providerId).toBe('open-meteo');
    expect(result.ranking?.order).toEqual(['open-meteo']);
    expect(result.ranking?.results.find((entry) => entry.id === 'custom')?.ok).toBe(false);
    expect(result.ranking?.results.find((entry) => entry.id === 'open-meteo-cma')?.ok).toBe(false);
  });

  it('returns stale local weather offline without another network request', async () => {
    const fetchImpl = vi.fn(async () => response(openMeteoPayload())) as unknown as typeof fetch;
    const first = await fetchCurrentWeather(30, 120, { fetchImpl, force: true, mode: 'global' });
    const offline = await fetchCurrentWeather(30, 120, {
      fetchImpl, force: true, online: false, mode: 'global'
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(offline.data.cached).toBe(true);
    expect(offline.data.summary.temp).toBe(first.data.summary.temp);
  });

  it('uses a fresh cache without probing again', async () => {
    const fetchImpl = vi.fn(async () => response(openMeteoPayload())) as unknown as typeof fetch;
    await fetchCurrentWeather(30, 120, { fetchImpl, force: true, mode: 'global' });
    const cached = await fetchCurrentWeather(30, 120, { fetchImpl, mode: 'global' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cached.data.cached).toBe(true);
  });
});

describe('weather alerts and records', () => {
  it('detects extreme thresholds and selects the highest alert', () => {
    expect(assessWeatherAlert({ code: 97 })).toMatchObject({ level: 'extreme', kind: 'thunderstorm' });
    expect(assessWeatherAlert({ precipitation: 30 })).toMatchObject({ level: 'extreme', kind: 'heavyRain' });
    expect(assessWeatherAlert({ gust: 125 })).toMatchObject({ level: 'extreme', kind: 'wind' });
    expect(assessWeatherAlert({ temp: 41 })).toMatchObject({ level: 'extreme', kind: 'heat' });
    expect(primaryWeatherAlert([
      { level: 'warning', kind: 'heavyRain' },
      { level: 'severe', kind: 'thunderstorm' },
      { level: 'warning', kind: 'wind' }
    ])?.kind).toBe('thunderstorm');
  });

  it('keeps the strongest next-three-hour risk instead of an earlier weaker warning', async () => {
    const now = Date.now();
    const times = [0, 1, 2].map((hours) => new Date(now + hours * 3600_000).toISOString());
    const fetchImpl = vi.fn(async () => response(openMeteoPayload({
      current: { time: times[0], temperature_2m: 20, weather_code: 0 },
      hourly: {
        time: times, temperature_2m: [20, 20, 20], weather_code: [0, 61, 95],
        precipitation: [0, 0, 0], precipitation_probability: [0, 90, 90],
        wind_speed_10m: [5, 5, 5], wind_gusts_10m: [8, 8, 8]
      }
    }))) as unknown as typeof fetch;

    const result = await fetchCurrentWeather(30, 120, { fetchImpl, cache: false, force: true, mode: 'global' });
    const forecast = result.data.alerts.find((alert) => alert.forecast);
    expect(forecast).toMatchObject({ level: 'severe', kind: 'thunderstorm' });
    expect(forecast?.startsAt).toBe(Date.parse(times[2]));
  });

  it('normalizes, sorts and deduplicates recorded weather without accepting bad coordinates', () => {
    const time = new Date(2026, 10, 20, 9, 0).getTime();
    const records = normalizeWeatherLog([
      sample(time + 20_000),
      sample(time),
      sample(time + 60_000, { source: 'Other' }),
      sample(time + 180_000, { lat: 91 })
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((entry) => entry.source)).toEqual(['Open-Meteo', 'Other']);
    expect(weatherConditionLabelKey({ code: 95 })).toBe('story.codes.thunder');
  });
});
