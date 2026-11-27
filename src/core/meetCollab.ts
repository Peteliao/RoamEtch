// Pure collaboration helpers for live meetups: temporary markers, assembly
// goals, spread metrics and alert rate limiting. Kept renderer-free so the
// protocol can be unit tested without DOM or relay.
import { haversine } from './geo';

export const MEET_FEATURE_VERSION = 4;
export const MEET_MARKER_TYPES = ['here', 'gather', 'supply', 'danger', 'scenic', 'parking'] as const;
export type MeetMarkerType = typeof MEET_MARKER_TYPES[number];
export const MEET_MARKER_TTL_OPTIONS = [15, 30, 60, 120] as const;
export const MEET_MARKER_MIN_TTL_MIN = 5;
export const MEET_MARKER_MAX_TTL_MIN = 480;
export const MEET_MARKER_MAX_PER_PEER = 8;
export const MEET_MARKER_SESSION_MAX = 48;
export const MEET_MARKER_LABEL_MAX = 24;

export const MEET_ALERT_DISTANCE_MIN_M = 100;
export const MEET_ALERT_DISTANCE_MAX_M = 5000;
export const MEET_ALERT_DISTANCE_DEFAULT_M = 500;
export const MEET_ALERT_COOLDOWN_MIN = 1;
export const MEET_ALERT_COOLDOWN_MAX_MIN = 60;
export const MEET_ALERT_COOLDOWN_DEFAULT_MIN = 5;

const MARKER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

export function clampMarkerTtl(value: unknown) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 30;
  return Math.min(MEET_MARKER_MAX_TTL_MIN, Math.max(MEET_MARKER_MIN_TTL_MIN, n));
}

export function clampAlertDistance(value: unknown) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MEET_ALERT_DISTANCE_DEFAULT_M;
  return Math.min(MEET_ALERT_DISTANCE_MAX_M, Math.max(MEET_ALERT_DISTANCE_MIN_M, n));
}

export function clampAlertCooldown(value: unknown) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return MEET_ALERT_COOLDOWN_DEFAULT_MIN;
  return Math.min(MEET_ALERT_COOLDOWN_MAX_MIN, Math.max(MEET_ALERT_COOLDOWN_MIN, n));
}

export function cleanMarkerLabel(value: unknown) {
  return String(value ?? '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, MEET_MARKER_LABEL_MAX);
}

export function isMeetMarkerType(value: unknown): value is MeetMarkerType {
  return MEET_MARKER_TYPES.includes(String(value) as MeetMarkerType);
}

export type MeetMarker = {
  id: string;
  type: MeetMarkerType;
  lat: number;
  lon: number;
  label: string;
  ttlMin: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

/** Validates an incoming `mk` packet and anchors its expiry at receipt time. */
function coordinate(value: unknown) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return Number.NaN;
  return Number(value);
}

function validCoordinates(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

export function sanitizeMeetMarker(message: any, now: number): MeetMarker | null {
  if (!message || message.del) return null;
  const id = String(message.mkid || '');
  if (!MARKER_ID_RE.test(id)) return null;
  const type = String(message.mtyp || '');
  if (!isMeetMarkerType(type)) return null;
  const lat = coordinate(message.la);
  const lon = coordinate(message.lo);
  if (!validCoordinates(lat, lon)) return null;
  const ttlMin = clampMarkerTtl(message.ttl);
  return {
    id,
    type,
    lat,
    lon,
    label: cleanMarkerLabel(message.tx),
    ttlMin,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMin * 60_000
  };
}

export function markerExpired(marker: Pick<MeetMarker, 'expiresAt'>, now: number) {
  return marker.expiresAt <= now;
}

export type MeetGoal = {
  lat: number; lon: number; label: string; at: number;
  by?: string; byName?: string; distance?: number | null;
};

export function sanitizeMeetGoal(message: any, now: number): MeetGoal | null {
  if (!message || message.del) return null;
  const lat = coordinate(message.la);
  const lon = coordinate(message.lo);
  if (!validCoordinates(lat, lon)) return null;
  return { lat, lon, label: cleanMarkerLabel(message.tx), at: now };
}

/** Spread = largest pairwise distance between fresh team positions. */
export function computeMeetSpread(points: Array<{ id?: string; lat?: number | null; lon?: number | null }>) {
  const usable = (points || []).filter((p) => p
    && typeof p.lat === 'number' && Number.isFinite(p.lat)
    && typeof p.lon === 'number' && Number.isFinite(p.lon));
  if (usable.length < 2) return null;
  let maxMeters = 0;
  let fromId = '';
  let toId = '';
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const d = haversine(usable[i].lat as number, usable[i].lon as number, usable[j].lat as number, usable[j].lon as number);
      if (d > maxMeters) {
        maxMeters = d;
        fromId = String(usable[i].id || '');
        toId = String(usable[j].id || '');
      }
    }
  }
  return { count: usable.length, maxMeters, fromId, toId };
}

export function alertCooldownElapsed(lastAt: number | undefined, now: number, cooldownMs: number) {
  return !lastAt || now - lastAt >= Math.max(0, cooldownMs);
}

/**
 * Goal-zone transition: only a near -> far crossing counts as a deviation, so
 * setting a distant goal for the whole team does not immediately alert.
 */
export function goalZoneAfter(previousNear: boolean | undefined, distance: number | null, threshold: number) {
  if (distance == null || !Number.isFinite(distance)) return { near: previousNear, deviated: false };
  const near = distance <= Math.max(1, threshold);
  return { near, deviated: previousNear === true && near === false };
}

/** Sliding-window limiter for sender-side chat/voice/marker budgets. */
export class MeetSendLimiter {
  private windows = new Map<string, number[]>();

  allow(kind: string, now: number, limit: number, windowMs: number) {
    const recent = (this.windows.get(kind) || []).filter((at) => now - at < windowMs);
    if (recent.length >= limit) {
      this.windows.set(kind, recent);
      return false;
    }
    recent.push(now);
    this.windows.set(kind, recent);
    return true;
  }

  retryAfter(kind: string, now: number, limit: number, windowMs: number) {
    const recent = (this.windows.get(kind) || []).filter((at) => now - at < windowMs);
    if (recent.length < limit) return 0;
    return Math.max(0, windowMs - (now - recent[0]));
  }

  clear() {
    this.windows.clear();
  }
}

export const SEND_LIMITS = {
  text: { limit: 8, windowMs: 10_000 },
  voice: { limit: 3, windowMs: 30_000 },
  marker: { limit: 6, windowMs: 60_000 },
  goal: { limit: 4, windowMs: 60_000 }
} as const;
