// Speed-pattern activity classifier for 'auto' mode (metres/second samples).
export function classifyActivity(samples) {
  const mov = samples.filter((v) => v > 0.5 && v < 80);
  if (mov.length < 6) return null;
  const sorted = [...mov].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const p50 = q(0.5);
  const slowFrac = mov.filter((v) => v < 2).length / mov.length;
  const fastFrac = mov.filter((v) => v > 8.5).length / mov.length;
  if (fastFrac > 0.25 && slowFrac > 0.25) return 'travel';
  if (p50 > 8.5) return 'drive';
  if (p50 > 3.6) return 'bike';
  if (p50 > 2.0) return 'run';
  return 'hike';
}