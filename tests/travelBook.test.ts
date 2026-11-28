// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { buildTravelBook } from '../src/core/travelBook';
import { normalizeStory } from '../src/core/story';
import { initI18n, setLanguage } from '../src/core/i18n';

const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();

function full(): any {
  return {
    trip: { id: 't1', name: 'Ridge walk', activity: 'hike', createdAt: T0 },
    segments: [{
      id: 's1',
      points: [
        { lat: 30, lon: 120, t: T0, alt: 100 },
        { lat: 30.001, lon: 120.001, t: T0 + 10 * 60_000, alt: 130 }
      ]
    }],
    waypoints: [
      { id: 'w1', name: 'Ridge', desc: 'Windy', type: 'view', time: T0 + 5 * 60_000, lat: 30.0005, lon: 120.0005, hidden: false, mediaIds: ['m1'] },
      { id: 'w2', name: 'Secret Camp', desc: 'Private', type: 'stay', time: T0 + 6 * 60_000, lat: 30.0006, lon: 120.0006, hidden: true, mediaIds: ['m2'] }
    ],
    media: [
      { id: 'm1', blob: new Blob(['visible'], { type: 'image/jpeg' }), thumb: new Blob(['thumb1'], { type: 'image/jpeg' }) },
      { id: 'm2', blob: new Blob(['hidden'], { type: 'image/jpeg' }), thumb: new Blob(['thumb2'], { type: 'image/jpeg' }) }
    ]
  };
}

beforeAll(async () => {
  await initI18n();
  await setLanguage('en');
});

describe('travel book export', () => {
  it('applies privacy before days, includes disclosed manual weather and notes', async () => {
    const story = normalizeStory({
      title: 'Ridge story',
      intro: 'A quiet morning.',
      dayNotes: { '2026-11-20': 'Fog lifted at noon.' },
      manualWeather: { '2026-11-20': { temp: 8, condition: 'mist', note: 'Measured at the trailhead' } }
    });
    const html = await buildTravelBook(full(), {
      story,
      includePhotos: true,
      privacy: { radius: 0, hideSensitive: true, hideStartIcon: true, hideEndIcon: true }
    });
    expect(html).toContain('Ridge story');
    expect(html).toContain('A quiet morning.');
    expect(html).toContain('Fog lifted at noon.');
    expect(html).toContain('Ridge');
    expect(html).not.toContain('Secret Camp');
    expect(html).not.toContain('Private');
    expect(html).toContain('mist');
    expect(html).toContain('Measured at the trailhead');
    expect(html).toContain('data:image/jpeg;base64,');
    expect(html.match(/data:image\/jpeg;base64,/g)).toHaveLength(1);
    expect(html).toContain('<svg');
    expect(html).not.toContain('class="route-label"');
    expect(html).toContain('RoamEtch');
  });

  it('omits photo markup when export excludes photos', async () => {
    const html = await buildTravelBook(full(), {
      story: normalizeStory({ title: 'No photos' }),
      includePhotos: false,
      privacy: { radius: 0, hideSensitive: false }
    });
    expect(html).not.toContain('data:image/jpeg;base64,');
    expect(html).toContain('Secret Camp');
  });

  it('exports recorded weather, source and alerts with custom text escaped', async () => {
    const data = full();
    data.trip.weatherLog = [{
      time: T0 + 60_000, lat: 30.0005, lon: 120.0005,
      source: '<img src=x onerror=alert(1)>', providerId: 'custom',
      summary: {
        temp: 18, code: 95, condition: '<b>雷暴</b>', rain: 90, wind: 55,
        uv: null, hour: 9, sample: '2026-11-20 09:00', missing: ['uv']
      },
      alerts: [{ level: 'severe', kind: 'thunderstorm', official: true, message: '<script>alert(1)</script>' }]
    }];
    const html = await buildTravelBook(data, {
      story: normalizeStory({ title: 'Storm story' }),
      includePhotos: false,
      privacy: { radius: 0, hideSensitive: false }
    });
    expect(html).toContain('Recorded during trip');
    expect(html).toContain('Trip record');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;雷暴&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('weather-alert severe');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
