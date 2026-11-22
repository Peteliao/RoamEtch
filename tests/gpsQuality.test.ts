import { describe, expect, it } from 'vitest';
import { assessGpsQuality } from '../src/core/gpsQuality';

function fix(t, acc = 5, alt = 100) {
  return { lat: 30, lon: 120, t, acc, alt };
}

describe('GPS quality', () => {
  it('scores a clean, continuous track highly', () => {
    const q = assessGpsQuality([fix(0), fix(30_000), fix(60_000), fix(90_000)]);
    expect(q.score).toBeGreaterThanOrEqual(95);
    expect(q.rating).toBe('excellent');
    expect(q.gaps).toBe(0);
    expect(q.avgAcc).toBe(5);
  });

  it('penalises poor accuracy and long gaps', () => {
    const q = assessGpsQuality([
      fix(0, 80, 100), fix(30_000, 90, 110),
      fix(1_200_000, 70, 170), fix(1_230_000, 85, 100)
    ]);
    expect(q.gaps).toBe(1);
    expect(q.gapMs).toBeGreaterThan(1_000_000);
    expect(q.poorFixes).toBe(4);
    expect(q.altJumps).toBe(1);
    expect(q.score).toBeLessThan(50);
    expect(q.rating).toBe('poor');
  });

  it('returns no score when there is neither accuracy nor time', () => {
    const q = assessGpsQuality([{ lat: 30, lon: 120, alt: 100 }, { lat: 30.001, lon: 120, alt: 101 }]);
    expect(q.score).toBe(null);
    expect(q.hasTime).toBe(false);
  });
});
