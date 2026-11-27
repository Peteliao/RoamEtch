// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildTravelBook } from '../src/core/travelBook';
import { normalizeStory } from '../src/core/story';

const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();

function full() {
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
});
