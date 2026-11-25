export const MEET_HOST_COLOR = '#f5b942';
export const MEET_MEMBER_COLOR = '#2bcda7';

export function meetRoleColor(isHost: boolean) {
  return isHost ? MEET_HOST_COLOR : MEET_MEMBER_COLOR;
}

export function meetProximityZoom(distance: number, latitude: number) {
  if (!Number.isFinite(distance)) return 11;
  if (distance <= 0) return 18;
  const lat = Math.max(-85, Math.min(85, Number(latitude) || 0));
  const worldMeters = 156543.03392804097 * Math.cos(lat * Math.PI / 180);
  return Math.max(11, Math.min(18, Math.log2(worldMeters * 170 / distance)));
}
