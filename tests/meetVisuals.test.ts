import { describe, expect, it } from 'vitest';
import { MEET_HOST_COLOR, MEET_MEMBER_COLOR, meetProximityZoom, meetRoleColor } from '../src/core/meetVisuals';

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
});
