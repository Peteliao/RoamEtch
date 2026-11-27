import { describe, expect, it } from 'vitest';
import { flattenTrack, matchPhotoToTrip } from '../src/core/photoMatch';

const T0 = new Date(2026, 10, 20, 9, 0, 0).getTime();
const points = [
  { lat: 30, lon: 120, t: T0, alt: 100 },
  { lat: 30.001, lon: 120.001, t: T0 + 5 * 60_000, alt: 110 },
  { lat: 30.002, lon: 120.002, t: T0 + 10 * 60_000, alt: 120 },
  { lat: 30.003, lon: 120.003, t: T0 + 15 * 60_000, alt: 130 }
];
const segments = [{ id: 's1', points }];
const nodes = [{ id: 'w1', name: 'Ridge', lat: 30.001, lon: 120.001, time: T0 + 5 * 60_000, desc: '' }];

describe('photo association', () => {
  it('flattens segments with cumulative distance', () => {
    const track = flattenTrack(segments);
    expect(track.pts).toHaveLength(4);
    expect(track.cum[0]).toBe(0);
    expect(track.cum[3]).toBeGreaterThan(track.cum[2]);
    expect(track.start).toBe(T0);
    expect(track.end).toBe(T0 + 15 * 60_000);
  });

  it('requires at least time or GPS', () => {
    expect(matchPhotoToTrip({}, segments, nodes)).toBeNull();
    expect(matchPhotoToTrip({ lat: 40, lon: 130, time: T0 + 60 * 60_000 }, segments, nodes)).toBeNull();
  });

  it('matches by time and links a nearby node', () => {
    const match = matchPhotoToTrip({ time: T0 + 6 * 60_000 }, segments, nodes);
    expect(match).not.toBeNull();
    expect(match!.basis).toBe('time');
    expect(match!.waypointId).toBe('w1');
    expect(match!.lat).toBeGreaterThan(30);
    expect(match!.distanceAlong).toBeGreaterThan(0);
  });

  it('prefers agreed GPS and time with high confidence', () => {
    const match = matchPhotoToTrip({ time: T0 + 5.5 * 60_000, lat: 30.0011, lon: 120.0011 }, segments, nodes);
    expect(match).not.toBeNull();
    expect(match!.basis).toBe('gps+time');
    expect(match!.confidence).toBe('high');
    expect(match!.trackDistance).toBeLessThan(100);
  });

  it('uses GPS alone when the time falls outside the trip', () => {
    const match = matchPhotoToTrip({ time: T0 + 6 * 60 * 60_000, lat: 30.00201, lon: 120.00201 }, segments, nodes);
    expect(match).not.toBeNull();
    expect(match!.basis).toBe('gps');
    expect(match!.time).toBeGreaterThan(T0);
    expect(match!.confidence).toBe('medium');
  });
});
