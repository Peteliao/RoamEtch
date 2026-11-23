import { describe, expect, it } from 'vitest';
import {
  MOVING_DISTANCE_M,
  MOVING_PUBLISH_MS,
  STATIONARY_PUBLISH_MS,
  shouldPublishFix
} from '../src/core/meetCadence';

const BASE = { lat: 30, lon: 120, at: 0 };

function north(meters: number) {
  return BASE.lat + meters / 111_320;
}

describe('meetup publish cadence', () => {
  it('publishes the first fix immediately', () => {
    expect(shouldPublishFix(null, 30, 120, 0, null)).toBe(true);
  });

  it('throttles a stationary teammate to the slow heartbeat', () => {
    expect(shouldPublishFix(BASE, 30, 120, STATIONARY_PUBLISH_MS - 1, 0)).toBe(false);
    expect(shouldPublishFix(BASE, 30, 120, STATIONARY_PUBLISH_MS, 0)).toBe(true);
    expect(shouldPublishFix(BASE, 30, 120, 10_000, 0.2)).toBe(false);
  });

  it('keeps moving updates responsive', () => {
    expect(shouldPublishFix(BASE, north(2), 120, MOVING_PUBLISH_MS - 1, 1.4)).toBe(false);
    expect(shouldPublishFix(BASE, north(2), 120, MOVING_PUBLISH_MS, 1.4)).toBe(true);
    expect(shouldPublishFix(BASE, north(MOVING_DISTANCE_M + 1), 120, 1_000, null)).toBe(true);
  });

  it('ignores slow GPS drift until the heartbeat is due', () => {
    expect(shouldPublishFix(BASE, north(2), 120, 9_000, null)).toBe(false);
    expect(shouldPublishFix(BASE, north(2), 120, 9_000, 0.1)).toBe(false);
  });
});
