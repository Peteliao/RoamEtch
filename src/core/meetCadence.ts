import { haversine } from './geo';

export const MOVING_PUBLISH_MS = 5_000;
export const MOVING_DISTANCE_M = 8;
export const STATIONARY_PUBLISH_MS = 25_000;
export const STATIONARY_SPEED_MPS = 0.6;

export interface LastPublish {
  lat: number;
  lon: number;
  at: number;
}

export function shouldPublishFix(
  last: LastPublish | null,
  lat: number,
  lon: number,
  now: number,
  speed: number | null
): boolean {
  if (!last) return true;
  const elapsed = Math.max(0, now - last.at);
  const moved = haversine(last.lat, last.lon, lat, lon);
  const measured = elapsed > 0 ? moved / (elapsed / 1000) : 0;
  const moving = (speed != null && Number.isFinite(speed) && speed > STATIONARY_SPEED_MPS)
    || measured > STATIONARY_SPEED_MPS
    || moved >= MOVING_DISTANCE_M;
  return moving
    ? elapsed >= MOVING_PUBLISH_MS || moved >= MOVING_DISTANCE_M
    : elapsed >= STATIONARY_PUBLISH_MS;
}
