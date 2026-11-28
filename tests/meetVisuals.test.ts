import { describe, expect, it } from 'vitest';
import {
  MEET_HOST_COLOR, MEET_MEMBER_COLOR, meetFitKey, meetMarkerScale, meetProximityZoom,
  meetRoleColor, renderedMeetPoints
} from '../src/core/meetVisuals';

describe('meet role visuals', () => {
  it('uses distinct host and member colors', () => {
    expect(meetRoleColor(true)).toBe(MEET_HOST_COLOR);
    expect(meetRoleColor(false)).toBe(MEET_MEMBER_COLOR);
    expect(MEET_HOST_COLOR).not.toBe(MEET_MEMBER_COLOR);
  });

  it('zooms in smoothly as teammates approach and respects safe limits', () => {
    const far = meetProximityZoom(5000, 31);
    const near = meetProximityZoom(500, 31);
    const closer = meetProximityZoom(50, 31);
    expect(far).toBeLessThan(near);
    expect(near).toBeLessThan(closer);
    expect(meetProximityZoom(1_000_000, 31)).toBe(11);
    expect(meetProximityZoom(0, 31)).toBe(18);
    expect(meetProximityZoom(Number.NaN, 31)).toBe(11);
  });

  it('clamps marker scaling at both zoom extremes', () => {
    expect(meetMarkerScale(0)).toBe(0.72);
    expect(meetMarkerScale(12)).toBe(0.72);
    expect(meetMarkerScale(16)).toBeCloseTo(1);
    expect(meetMarkerScale(30)).toBe(1.28);
    expect(meetMarkerScale(Number.NaN)).toBe(0.72);
  });

  it('fits every rendered marker but excludes left peers and invalid coordinates', () => {
    const self = { hasFix: true, lat: 10, lon: 170, positionStatus: 'stale' };
    const peers = [
      { id: 'a', lat: 20, lon: 175, networkStatus: 'offline', positionStatus: 'paused' },
      { id: 'left', lat: 50, lon: 0, networkStatus: 'left' },
      { id: 'bad', lat: Number.NaN, lon: 1 }
    ];
    const goal = { lat: -20, lon: -179, at: 1 };
    const pins = [{ id: 'pin', by: 'a', lat: 30, lon: 179 }, { id: 'bad', lat: 91, lon: 2 }];
    expect(renderedMeetPoints(self, peers, pins, goal)).toEqual([
      { lat: 10, lon: 170 }, { lat: 20, lon: 175 }, { lat: -20, lon: -179 }, { lat: 30, lon: 179 }
    ]);
    expect(renderedMeetPoints({ hasFix: false, lat: 1, lon: 1 })).toEqual([]);
  });

  it('keeps the fit key stable across coordinate ticks and peer re-ranking', () => {
    const self = { hasFix: true, lat: 30, lon: 120 };
    const peers = [{ id: 'b', lat: 31, lon: 121 }, { id: 'a', lat: 32, lon: 122 }];
    const pins = [{ id: 'p', by: 'a', lat: 33, lon: 123 }];
    const goal = { by: 'a', at: 100, lat: 34, lon: 124 };
    const key = meetFitKey(self, peers, pins, goal);
    expect(meetFitKey({ ...self, lat: 30.1 }, [...peers].reverse().map((p) => ({ ...p, lat: p.lat + 1 })), pins, { ...goal, lon: 125 })).toBe(key);
    expect(meetFitKey(self, [...peers, { id: 'c', lat: 35, lon: 125 }], pins, goal)).not.toBe(key);
    expect(meetFitKey(self, peers.map((p) => p.id === 'a' ? { ...p, networkStatus: 'left' } : p), pins, goal)).not.toBe(key);
    expect(meetFitKey(self, peers, [], goal)).not.toBe(key);
    expect(meetFitKey(self, peers, pins, { ...goal, at: 101 })).not.toBe(key);
  });
});
