// MET-based calorie estimation for supported activities. Values are deliberate
// approximations for local-only stats — not medical or training advice.
type Activity = string;

const SUPPORTED = new Set(['hike', 'bike', 'run', 'travel']);

export function supportsCalories(activity: Activity) {
  return SUPPORTED.has(activity);
}

export function metForActivity(activity: Activity, speedMs = 0) {
  if (!SUPPORTED.has(activity)) return null;
  const kmh = Math.max(0, (speedMs || 0) * 3.6);
  if (activity === 'hike') {
    if (kmh < 2) return 3.5;
    if (kmh < 4) return 4.5;
    if (kmh < 5.5) return 6.0;
    return 7.5;
  }
  if (activity === 'run') {
    if (kmh < 7) return 7.0;
    if (kmh < 9) return 8.3;
    if (kmh < 11) return 9.8;
    if (kmh < 13) return 11.0;
    return 12.3;
  }
  if (activity === 'bike') {
    if (kmh < 12) return 4.0;
    if (kmh < 16) return 6.0;
    if (kmh < 19) return 6.8;
    if (kmh < 22) return 8.0;
    if (kmh < 25) return 10.0;
    return 12.0;
  }
  return kmh < 1 ? 2.5 : 4.0; // travel: sightseeing pace
}

export function estimateCalories(activity: Activity, movingMs, avgSpeed = 0, weightKg = 65) {
  const met = metForActivity(activity, avgSpeed);
  if (met == null || movingMs == null || !isFinite(movingMs)) return null;
  const weight = Math.max(30, Math.min(200, +weightKg || 65));
  return Math.round(met * weight * (Math.max(0, movingMs) / 3600000));
}
