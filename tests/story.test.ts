import { describe, expect, it } from 'vitest';
import { buildStoryDays, normalizeStory, storyDayLabel, storySummary } from '../src/core/story';

const DAY1 = new Date(2026, 10, 20, 23, 50, 0).getTime();
const DAY2 = new Date(2026, 10, 21, 0, 10, 0).getTime();

function full(): any {
  return {
    trip: { id: 't1', name: 'Two days', activity: 'hike', createdAt: DAY1 },
    segments: [{
      id: 's1',
      points: [
        { lat: 30, lon: 120, t: DAY1, alt: 100 },
        { lat: 30.001, lon: 120.001, t: DAY1 + 4 * 60_000, alt: 110 },
        { lat: 30.002, lon: 120.002, t: DAY2, alt: 120 },
        { lat: 30.003, lon: 120.003, t: DAY2 + 4 * 60_000, alt: 130 }
      ]
    }],
    waypoints: [
      { id: 'w1', name: 'Night camp', type: 'stay', time: DAY1 + 5 * 60_000, lat: 30.001, lon: 120.001, mediaIds: ['m1'] },
      { id: 'w2', name: 'Morning ridge', type: 'view', time: DAY2 + 2 * 60_000, lat: 30.002, lon: 120.002, mediaIds: [] }
    ],
    media: [{ id: 'm1', blob: new Blob(['x']), thumb: new Blob(['x']) }]
  };
}

describe('travel story days', () => {
  it('splits midnight-spanning recordings into local days', () => {
    const days = buildStoryDays(full(), { lang: 'zh', ascentThreshold: 4 });
    expect(days).toHaveLength(2);
    expect(days[0].day).toBe('2026-11-20');
    expect(days[1].day).toBe('2026-11-21');
    expect(days[0].segments[0].points).toHaveLength(2);
    expect(days[1].segments[0].points).toHaveLength(2);
    expect(days[0].nodes.map((n) => n.name)).toEqual(['Night camp']);
    expect(days[1].nodes.map((n) => n.name)).toEqual(['Morning ridge']);
    expect(days[0].photos).toHaveLength(1);
    expect(days[0].sun.available).toBe(true);
    expect(days[0].distance).toBeGreaterThan(0);
  });

  it('summarizes archive totals', () => {
    const days = buildStoryDays(full(), { lang: 'zh' });
    const total = storySummary(days);
    expect(total.days).toBe(2);
    expect(total.nodes).toBe(2);
    expect(total.photos).toBe(1);
    expect(total.distance).toBeGreaterThan(0);
  });

  it('normalizes stored story fields and localizes day labels', () => {
    expect(normalizeStory(null)).toEqual({ title: '', intro: '', dayNotes: {}, manualWeather: {}, updatedAt: undefined });
    expect(normalizeStory({ title: 'A', dayNotes: { '2026-11-20': 'cold' } }).dayNotes['2026-11-20']).toBe('cold');
    expect(storyDayLabel('2026-11-20', 'en')).toMatch(/Nov/);
    expect(storyDayLabel('2026-11-20', 'zh')).toContain('11');
  });

  it('keeps a day with only a node and no track', () => {
    const data = full();
    data.segments = [];
    const days = buildStoryDays(data, { lang: 'zh' });
    expect(days.map((day) => day.day)).toEqual(['2026-11-20', '2026-11-21']);
    expect(days.every((day) => day.hasTrack === false)).toBe(true);
  });

  it('groups normalized recording weather into the matching local day', () => {
    const data = full();
    data.trip.weatherLog = [
      {
        time: DAY2 + 60_000, lat: 30.002, lon: 120.002, source: 'Open-Meteo', providerId: 'open-meteo',
        summary: { temp: 18, code: 95, rain: 90, wind: 42, uv: null, hour: 0, sample: '', missing: ['uv'] },
        alerts: [{ level: 'severe', kind: 'thunderstorm' }]
      },
      {
        time: DAY1 + 30_000, lat: 91, lon: 120, source: 'Bad', providerId: 'bad',
        summary: { temp: 18, code: 0 }, alerts: []
      }
    ];
    const days = buildStoryDays(data, { lang: 'zh' });
    expect(days[0].weather).toEqual([]);
    expect(days[1].weather).toHaveLength(1);
    expect(days[1].weather[0].summary.code).toBe(95);
    expect(days[1].weather[0].alerts[0].kind).toBe('thunderstorm');
  });

  it('keeps a weather-only chapter even when there is no track or node', () => {
    const data = full();
    data.segments = [];
    data.waypoints = [];
    data.trip.weatherLog = [{
      time: DAY2 + 60_000, lat: 30, lon: 120, source: 'Open-Meteo', providerId: 'open-meteo',
      summary: { temp: 12, code: 3, rain: null, wind: 5, uv: 1, hour: 0, sample: '', missing: ['rain'] },
      alerts: []
    }];
    const days = buildStoryDays(data, { lang: 'zh' });
    expect(days).toHaveLength(1);
    expect(days[0].day).toBe('2026-11-21');
    expect(days[0].weather).toHaveLength(1);
    expect(days[0].hasTrack).toBe(false);
  });
});
