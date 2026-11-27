import { describe, expect, it } from 'vitest';
import {
  alertCooldownElapsed,
  cleanMarkerLabel,
  clampAlertCooldown,
  clampAlertDistance,
  clampMarkerTtl,
  computeMeetSpread,
  goalZoneAfter,
  isMeetMarkerType,
  markerExpired,
  MeetSendLimiter,
  sanitizeMeetGoal,
  sanitizeMeetMarker,
  SEND_LIMITS
} from '../src/core/meetCollab';

const NOW = 1_700_000_000_000;

function marker(overrides: any = {}) {
  return {
    mkid: 'marker01',
    mtyp: 'supply',
    la: 31.2,
    lo: 121.3,
    ttl: 30,
    ...overrides
  };
}

describe('temporary markers', () => {
  it('clamps TTL and labels to bounded, safe values', () => {
    expect(clampMarkerTtl(undefined)).toBe(30);
    expect(clampMarkerTtl(1)).toBe(5);
    expect(clampMarkerTtl(999)).toBe(480);
    expect(clampMarkerTtl('45')).toBe(45);
    expect(cleanMarkerLabel('  meet\u0000  at\n the\t pavilion  ')).toBe('meet at the pavilion');
    expect(cleanMarkerLabel('x'.repeat(40))).toHaveLength(24);
    expect(isMeetMarkerType('danger')).toBe(true);
    expect(isMeetMarkerType('unknown')).toBe(false);
  });

  it('sanitizes incoming markers and anchors expiry at receipt time', () => {
    const sanitized = sanitizeMeetMarker(marker({ tx: 'Water' }), NOW);
    expect(sanitized).toMatchObject({
      id: 'marker01',
      type: 'supply',
      lat: 31.2,
      lon: 121.3,
      label: 'Water',
      ttlMin: 30,
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: NOW + 30 * 60_000
    });

    expect(sanitizeMeetMarker(marker({ mkid: 'bad id' }), NOW)).toBeNull();
    expect(sanitizeMeetMarker(marker({ mtyp: 'meeting' }), NOW)).toBeNull();
    expect(sanitizeMeetMarker(marker({ la: 91 }), NOW)).toBeNull();
    expect(sanitizeMeetMarker(marker({ lo: Number.NaN }), NOW)).toBeNull();
    expect(sanitizeMeetMarker(marker({ del: true }), NOW)).toBeNull();
    expect(sanitizeMeetMarker(null, NOW)).toBeNull();
  });

  it('expires markers exactly at their deadline', () => {
    const sanitized = sanitizeMeetMarker(marker({ ttl: 15 }), NOW)!;
    expect(markerExpired(sanitized, sanitized.expiresAt - 1)).toBe(false);
    expect(markerExpired(sanitized, sanitized.expiresAt)).toBe(true);
  });
});

describe('assembly goal', () => {
  it('accepts bounded coordinates and clips labels', () => {
    expect(sanitizeMeetGoal({ la: 30, lo: 120, tx: ' Trailhead ' }, NOW))
      .toEqual({ lat: 30, lon: 120, label: 'Trailhead', at: NOW });
    expect(sanitizeMeetGoal({ la: 30, lo: 181 }, NOW)).toBeNull();
    expect(sanitizeMeetGoal({ la: null, lo: 120 }, NOW)).toBeNull();
    expect(sanitizeMeetGoal({ del: true }, NOW)).toBeNull();
  });

  it('only reports a deviation on a near-to-far transition', () => {
    expect(goalZoneAfter(undefined, 120, 500)).toEqual({ near: true, deviated: false });
    expect(goalZoneAfter(false, 900, 500)).toEqual({ near: false, deviated: false });
    expect(goalZoneAfter(true, 900, 500)).toEqual({ near: false, deviated: true });
    expect(goalZoneAfter(true, 500, 500)).toEqual({ near: true, deviated: false });
    expect(goalZoneAfter(true, null, 500)).toEqual({ near: true, deviated: false });
  });
});

describe('team spread and alerts', () => {
  it('finds the farthest pair among valid fresh positions', () => {
    const spread = computeMeetSpread([
      { id: 'a', lat: 30, lon: 120 },
      { id: 'b', lat: 30, lon: 120.01 },
      { id: 'c', lat: 30.02, lon: 120 }
    ]);
    expect(spread).toMatchObject({ count: 3, fromId: 'b', toId: 'c' });
    expect(spread!.maxMeters).toBeGreaterThan(2000);
    expect(computeMeetSpread([{ id: 'a', lat: 30, lon: 120 }])).toBeNull();
  });

  it('clamps alert distance and cooldown', () => {
    expect(clampAlertDistance(10)).toBe(100);
    expect(clampAlertDistance(9000)).toBe(5000);
    expect(clampAlertDistance('nope')).toBe(500);
    expect(clampAlertCooldown(0)).toBe(1);
    expect(clampAlertCooldown(120)).toBe(60);
    expect(clampAlertCooldown(undefined)).toBe(5);
    expect(alertCooldownElapsed(undefined, NOW, 60_000)).toBe(true);
    expect(alertCooldownElapsed(NOW - 30_000, NOW, 60_000)).toBe(false);
    expect(alertCooldownElapsed(NOW - 60_000, NOW, 60_000)).toBe(true);
  });

  it('enforces sliding sender budgets and reports the wait time', () => {
    const limiter = new MeetSendLimiter();
    const { limit, windowMs } = SEND_LIMITS.voice;
    for (let i = 0; i < limit; i++) expect(limiter.allow('voice', NOW + i, limit, windowMs)).toBe(true);
    expect(limiter.allow('voice', NOW + limit, limit, windowMs)).toBe(false);
    expect(limiter.retryAfter('voice', NOW + limit, limit, windowMs)).toBe(windowMs - limit);
    expect(limiter.allow('voice', NOW + windowMs, limit, windowMs)).toBe(true);
    expect(limiter.allow('text', NOW, SEND_LIMITS.text.limit, SEND_LIMITS.text.windowMs)).toBe(true);

    limiter.clear();
    for (let i = 0; i < limit; i++) expect(limiter.allow('voice', NOW, limit, windowMs)).toBe(true);
  });
});
