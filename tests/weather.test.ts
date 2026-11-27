import { describe, expect, it } from 'vitest';
import {
  mergeManualWeather, parseWeatherPayload, pickWeatherHour, summarizeWeather,
  weatherCodeKey, weatherModelFor, weatherUrl
} from '../src/core/weather';

function payload() {
  return {
    timezone: 'Asia/Shanghai',
    utc_offset_seconds: 28800,
    hourly: {
      time: Array.from({ length: 24 }, (_, i) => `2026-11-20T${String(i).padStart(2, '0')}:00`),
      temperature_2m: Array.from({ length: 24 }, (_, i) => 10 + i / 24),
      weather_code: Array.from({ length: 24 }, () => 61),
      precipitation_probability: Array.from({ length: 24 }, () => null),
      wind_speed_10m: Array.from({ length: 24 }, () => 8),
      uv_index: Array.from({ length: 24 }, () => null)
    }
  };
}

describe('weather adapter', () => {
  it('parses hourly data and reports missing archive fields', () => {
    const day = parseWeatherPayload({ ...payload(), model: 'archive' }, '2026-11-20');
    expect(day.hours).toHaveLength(24);
    expect(day.model).toBe('archive');
    const hour = pickWeatherHour(day, new Date(2026, 10, 20, 14, 30).getTime());
    expect(hour!.h).toBe(14);
    const summary = summarizeWeather(day, new Date(2026, 10, 20, 14, 30).getTime());
    expect(summary.temp).toBeCloseTo(10.58, 1);
    expect(summary.missing).toEqual(['rain', 'uv']);
    expect(summary.sample).toBe('2026-11-20 14:00');
  });

  it('merges manual supplements without pretending fields are automatic', () => {
    const day = parseWeatherPayload({ ...payload(), model: 'archive' }, '2026-11-20');
    const summary = summarizeWeather(day, new Date(2026, 10, 20, 14, 30).getTime());
    const merged = mergeManualWeather(summary, { temp: 20, rain: 30, uv: 2, condition: '山雾', note: '体感偏冷' });
    expect(merged.manual).toBe(true);
    expect(merged.temp).toBe(20);
    expect(merged.rain).toBe(30);
    expect(merged.uv).toBe(2);
    expect(merged.missing).toEqual([]);
    expect(mergeManualWeather(summary, { rain: null }).missing).toEqual(['rain', 'uv']);
  });

  it('chooses the recent-forecast model only for supported dates', () => {
    expect(weatherModelFor('2026-11-20', '2026-11-27')).toBe('forecast');
    expect(weatherModelFor('2025-01-01', '2026-11-27')).toBe('archive');
    expect(weatherModelFor('2026-11-29', '2026-11-27')).toBe('forecast');
    expect(weatherUrl(30, 120, '2026-11-20', 'forecast')).toContain('api.open-meteo.com/v1/forecast');
    expect(weatherUrl(30, 120, '2025-01-01', 'archive')).toContain('archive-api.open-meteo.com');
  });

  it('maps WMO codes to stable i18n keys', () => {
    expect(weatherCodeKey(0)).toBe('clear');
    expect(weatherCodeKey(61)).toBe('rain');
    expect(weatherCodeKey(95)).toBe('thunder');
    expect(weatherCodeKey(null)).toBe('unknown');
  });

  it('rejects malformed payloads', () => {
    expect(() => parseWeatherPayload({}, '2026-11-20')).toThrow('bad weather payload');
  });
});
