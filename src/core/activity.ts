// Speed-pattern activity classifier for 'auto' mode (metres/second samples).
import { ACTIVITY_PHYSICS } from './geo';

export function classifyActivity(samples) {
  const mov = samples.filter((v) => v > 0.5 && v <= ACTIVITY_PHYSICS.travel.vmax * 1.3);
  if (mov.length < 6) return null;
  const sorted = [...mov].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const p50 = q(0.5);
  const slowFrac = mov.filter((v) => v < 2).length / mov.length;
  const fastFrac = mov.filter((v) => v > 8.5).length / mov.length;
  if (fastFrac > 0.25 && slowFrac > 0.25 && q(0.9) > ACTIVITY_PHYSICS.drive.vmax) return 'travel';
  if (p50 > ACTIVITY_PHYSICS.drive.vmax) return 'travel';
  if (p50 > 8.5) return 'drive';
  if (p50 > 3.6) return 'bike';
  if (p50 > 2.0) return 'run';
  return 'hike';
}