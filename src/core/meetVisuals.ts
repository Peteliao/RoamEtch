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

/** DOM markers grow gently at high zoom without covering the map at low zoom. */
export function meetMarkerScale(zoom: number, min = 0.72, max = 1.28) {
  if (!Number.isFinite(zoom)) return min;
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.max(low, Math.min(high, 0.72 + (zoom - 12) * 0.07));
}

export function validMeetWgs84Point(point: any) {
  return !!point && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
    && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;
}

/** Exactly the points represented by rendered self/peer/goal/pin markers. */
export function renderedMeetPoints(self: any, peers: any[] = [], markers: any[] = [], goal: any = null) {
  const points: Array<{ lat: number; lon: number }> = [];
  if (self?.hasFix && validMeetWgs84Point(self)) points.push({ lat: self.lat, lon: self.lon });
  for (const peer of Array.isArray(peers) ? peers : []) {
    if (peer?.networkStatus !== 'left' && validMeetWgs84Point(peer)) {
      points.push({ lat: peer.lat, lon: peer.lon });
    }
  }
  if (validMeetWgs84Point(goal)) points.push({ lat: goal.lat, lon: goal.lon });
  for (const pin of Array.isArray(markers) ? markers : []) {
    if (validMeetWgs84Point(pin)) points.push({ lat: pin.lat, lon: pin.lon });
  }
  return points;
}

/**
 * Stable across location ticks and peer distance re-ranking, but changes when
 * roster membership, marker rendering, or goal/pin availability changes.
 */
export function meetFitKey(self: any, peers: any[] = [], markers: any[] = [], goal: any = null) {
  const peerKeys = (Array.isArray(peers) ? peers : [])
    .map((peer) => `${String(peer?.id ?? '')}:${peer?.networkStatus !== 'left' && validMeetWgs84Point(peer) ? 1 : 0}`)
    .sort();
  const pinKeys = (Array.isArray(markers) ? markers : [])
    .filter((pin) => validMeetWgs84Point(pin))
    .map((pin) => `${String(pin?.by ?? '')}:${String(pin?.id ?? '')}`)
    .sort();
  return JSON.stringify({
    self: self?.hasFix && validMeetWgs84Point(self) ? 1 : 0,
    peers: peerKeys,
    pins: pinKeys,
    goal: validMeetWgs84Point(goal) ? `${String(goal?.by ?? '')}:${Number(goal?.at) || 0}` : 0
  });
}
